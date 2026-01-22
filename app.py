# MUST monkey patch before importing networking modules
import eventlet
eventlet.monkey_patch()

import os
import json
import base64
from datetime import datetime, timedelta, timezone

from flask import Flask, request, jsonify, send_from_directory, session
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.utils import secure_filename
from sqlalchemy import func
from apscheduler.schedulers.background import BackgroundScheduler

from message_reactions import message_reactions
from models import db, User, Message, RoomJoin, MessageReaction  # Import from models.py

# ------------------------------------------------------
# Utility: Content Safety
# ------------------------------------------------------
def is_content_safe(text):
    unsafe_keywords = ["malware", "phishing", "virus", "hack", "abuse"]
    text_lower = (text or "").lower()
    return not any(kw in text_lower for kw in unsafe_keywords)

# ------------------------------------------------------
# App Setup
# ------------------------------------------------------
app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///chat.db'
app.config["SECRET_KEY"] = "some_secret_key_for_sessions"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db.init_app(app)
app.register_blueprint(message_reactions)

UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "pdf", "txt", "doc", "docx"}
app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

CORS(app, supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# ------------------------------------------------------
# In-memory socket maps
# ------------------------------------------------------
users = {}         # sid -> username
rooms_users = {}   # room -> set(usernames)

with app.app_context():
    db.create_all()

# ------------------------------------------------------
# Delete expired messages periodically
# ------------------------------------------------------
def delete_expired_messages():
    now = datetime.now(timezone.utc)
    expired_msgs = Message.query.filter(Message.expires_at != None, Message.expires_at <= now).all()
    for msg in expired_msgs:
        db.session.delete(msg)
    db.session.commit()

scheduler = BackgroundScheduler()
scheduler.add_job(delete_expired_messages, "interval", minutes=5)
scheduler.start()

# ------------------------------------------------------
# Signup / Login / Logout
# ------------------------------------------------------
@app.route("/signup", methods=["POST"])
def signup():
    data = request.json or {}
    email = data.get("email")
    password = data.get("password")
    username = data.get("username")
    public_key = data.get("public_key")

    if not email or not password or not username:
        return jsonify({"error": "Missing fields"}), 400

    if User.query.filter_by(email=email).first():
        return jsonify({"error": "Email already registered"}), 400
    if User.query.filter_by(username=username).first():
        return jsonify({"error": "Username already taken"}), 400

    user = User(email=email, username=username, is_anonymous=False, public_key=public_key)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()

    return jsonify({"success": True, "message": "User created"})


@app.route("/anonymous-login", methods=["POST"])
def anonymous_login():
    import uuid
    data = request.json or {}
    public_key = data.get("public_key")
    anon_username = "anon_" + str(uuid.uuid4())[:8]

    user = User(email=f"{anon_username}@example.com", username=anon_username, is_anonymous=True, public_key=public_key)
    user.set_password(uuid.uuid4().hex)
    db.session.add(user)
    db.session.commit()

    session["user_id"] = user.id
    return jsonify({"success": True, "username": anon_username, "is_anonymous": True})

@app.route("/login", methods=["POST"])
def login():
    data = request.json or {}
    email = data.get("email")
    password = data.get("password")
    public_key = data.get("public_key")

    user = User.query.filter_by(email=email).first()
    if user and user.check_password(password):
        if public_key and public_key != user.public_key:
            user.public_key = public_key
            db.session.commit()
        session["user_id"] = user.id
        return jsonify({"success": True, "username": user.username, "is_anonymous": user.is_anonymous})
    return jsonify({"error": "Invalid credentials"}), 401

@app.route("/logout", methods=["POST"])
def logout():
    session.pop("user_id", None)
    return jsonify({"success": True, "message": "Logged out"})

# ------------------------------------------------------
# Public key retrieval
# ------------------------------------------------------
@app.route("/public-key/<username>")
def get_public_key(username):
    user = User.query.filter_by(username=username).first()
    if not user or not user.public_key:
        return jsonify({"error": "Public key not found"}), 404
    return jsonify({"public_key": user.public_key})

# ------------------------------------------------------
# Room users (for frontend live listing)
# ------------------------------------------------------
@app.route("/room-users/<room>")
def room_users_api(room):
    return jsonify({"users": list(rooms_users.get(room, set()))})

# ------------------------------------------------------
# Uploads
# ------------------------------------------------------
def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route("/uploads/<filename>")
def uploaded_file(filename):
    return send_from_directory(app.config["UPLOAD_FOLDER"], filename)

@app.route("/upload", methods=["POST"])
def upload_file():
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file provided"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": "Invalid file type"}), 400
    filename = secure_filename(file.filename)
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    file.save(filepath)
    return jsonify({"success": True, "url": f"/uploads/{filename}", "filename": filename})

# ------------------------------------------------------
# Messages endpoints (get/search/delete/edit/read)
# ------------------------------------------------------
@app.route("/messages/<room>")
def get_messages(room):
    username = request.args.get("username")
    if username:
        join_record = RoomJoin.query.filter_by(room=room, username=username).first()
        if join_record:
            min_time = join_record.join_time
            msgs = Message.query.filter(Message.room == room, Message.timestamp >= min_time).order_by(Message.timestamp.asc()).all()
        else:
            msgs = []
    else:
        msgs = Message.query.filter(Message.room == room).order_by(Message.timestamp.asc()).all()

    return jsonify([{
        "id": m.id,
        "username": m.username,
        "encrypted_map": json.loads(m.content) if m.content else {},
        "file_url": m.file_url,
        "file_name": m.file_name,
        "timestamp": m.timestamp.isoformat(),
        "expires_at": m.expires_at.isoformat() if m.expires_at else None,
        "delivered": m.delivered,
        "read": m.read,
        "delete_on_read": m.delete_on_read,
        "require_all_read": m.require_all_read
    } for m in msgs])

@app.route("/messages/search/<room>")
def search_messages(room):
    query = (request.args.get("q") or "").strip()
    username = request.args.get("username")
    if username:
        join_record = RoomJoin.query.filter_by(room=room, username=username).first()
        if not join_record:
            return jsonify([])
        min_time = join_record.join_time
        base_q = Message.query.filter(Message.room == room, Message.timestamp >= min_time)
    else:
        base_q = Message.query.filter(Message.room == room)

    if not query:
        msgs = base_q.order_by(Message.timestamp.asc()).all()
    else:
        search_str = f"%{query.lower()}%"
        msgs = base_q.filter(func.lower(Message.username).like(search_str)).order_by(Message.timestamp.asc()).all()

    return jsonify([{
        "id": m.id,
        "username": m.username,
        "encrypted_map": json.loads(m.content) if m.content else {},
        "file_url": m.file_url,
        "file_name": m.file_name,
        "timestamp": m.timestamp.isoformat(),
        "expires_at": m.expires_at.isoformat() if m.expires_at else None,
        "delivered": m.delivered,
        "read": m.read,
        "delete_on_read": m.delete_on_read,
        "require_all_read": m.require_all_read
    } for m in msgs])

@app.route("/messages/delete/<int:msg_id>", methods=["DELETE"])
def delete_message(msg_id):
    msg = Message.query.get(msg_id)
    if not msg:
        return jsonify({"error": "Message not found"}), 404
    db.session.delete(msg)
    db.session.commit()
    socketio.emit("delete_message", {"id": msg_id}, room=msg.room)
    return jsonify({"success": True, "deleted_id": msg_id})

@app.route("/messages/edit/<int:msg_id>", methods=["PUT"])
def edit_message(msg_id):
    data = request.json or {}
    encrypted_map = data.get("encrypted_map") or data.get("encryptedmap")
    if not encrypted_map:
        return jsonify({"error": "No content provided"}), 400
    msg = Message.query.get(msg_id)
    if not msg:
        return jsonify({"error": "Message not found"}), 404
    msg.content = json.dumps(encrypted_map)
    db.session.commit()
    socketio.emit("editmessage", {"id": msg_id, "encryptedmap": encrypted_map}, room=msg.room)
    return jsonify({"success": True, "id": msg_id})

@app.route("/messages/read/<int:msg_id>", methods=["POST"])
def mark_read(msg_id):
    msg = Message.query.get(msg_id)
    if not msg:
        return jsonify({"error": "Message not found"}), 404
    msg.read = True
    db.session.commit()
    socketio.emit("message_read", {"id": msg.id, "room": msg.room}, room=msg.room)
    return jsonify({"success": True, "id": msg.id})

# ------------------------------------------------------
# Socket events
# ------------------------------------------------------
@socketio.on("connect")
def on_connect():
    print("Client connected")

@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    username = users.pop(sid, None)
    rooms_to_update = []
    if username:
        for room, user_set in list(rooms_users.items()):
            if username in user_set:
                user_set.remove(username)
                rooms_to_update.append(room)

    for room in rooms_to_update:
        emit("online_users", {"users": list(rooms_users.get(room, set()))}, room=room)

@socketio.on("join")
def on_join(data):
    username = data.get("username")
    room = data.get("room")
    public_key = data.get("publicKey")
    if not username or not room:
        return

    user = User.query.filter_by(username=username).first()
    if user:
        if public_key and user.public_key != public_key:
            user.public_key = public_key
            db.session.commit()
    else:
        user = User(email=f"{username}@example.com", username=username, is_anonymous=True, public_key=public_key)
        user.set_password(os.urandom(8).hex())
        db.session.add(user)
        db.session.commit()

    now = datetime.now(timezone.utc)
    join_record = RoomJoin.query.filter_by(room=room, username=username).first()
    if join_record:
        join_record.join_time = now
    else:
        db.session.add(RoomJoin(room=room, username=username, join_time=now))
    db.session.commit()

    join_room(room)
    users[request.sid] = username
    if room not in rooms_users:
        rooms_users[room] = set()
    already_in_room = username in rooms_users[room]
    rooms_users[room].add(username)
    if not already_in_room:
        emit("status", {"msg": f"{username} has entered the room."}, room=room, skip_sid=request.sid)
    emit("online_users", {"users": list(rooms_users[room])}, room=room)

@socketio.on("leave")
def on_leave(data):
    username = data.get("username")
    room = data.get("room")
    if not username or not room:
        return

    leave_room(room)
    users.pop(request.sid, None)

    if room in rooms_users and username in rooms_users[room]:
        rooms_users[room].remove(username)
        emit("online_users", {"users": list(rooms_users[room])}, room=room)
        emit("status", {"msg": f"{username} has left the room."}, room=room, skip_sid=request.sid)

@socketio.on("message")
def handle_message(data):
    room = data.get("room")
    encrypted_map = data.get("encrypted_map", {}) or {}
    expires_at_ms = data.get("expires_at")
    delete_on_read = data.get("delete_on_read", False)
    require_all_read = data.get("require_all_read", False)
    username = users.get(request.sid, "Unknown")
    file_url = data.get("fileUrl")
    file_name = data.get("fileName")

    now = datetime.now(timezone.utc)
    expires_at = None
    if expires_at_ms:
        try:
            expires_at = datetime.fromtimestamp(int(expires_at_ms) / 1000.0, tz=timezone.utc)
            if expires_at <= now:
                expires_at = now + timedelta(seconds=1)
        except Exception:
            expires_at = None

    plaintext = data.get("plaintext")
    if plaintext and not is_content_safe(plaintext):
        emit("message_rejected", {"reason": "Message contains unsafe content"})
        return

    msg = Message(
        room=room,
        username=username,
        content=json.dumps(encrypted_map),
        file_url=file_url,
        file_name=file_name,
        expires_at=expires_at,
        delivered=True,
        read=False,
        readers="[]",
        delete_on_read=delete_on_read,
        require_all_read=require_all_read,
    )
    db.session.add(msg)
    db.session.commit()

    socketio.emit(
        "message",
        {
            "id": msg.id,
            "user": username,
            "plaintext": plaintext,
            "encrypted_map": encrypted_map,
            "fileUrl": file_url,
            "fileName": file_name,
            "expires_at": msg.expires_at.isoformat() if msg.expires_at else None,
            "delivered": True,
            "read": False,
            "delete_on_read": delete_on_read,
            "require_all_read": require_all_read,
        },
        room=room,
    )

@socketio.on("message_seen")
def message_seen(data):
    msg_id = data.get("id")
    msg = Message.query.get(msg_id)
    username = users.get(request.sid, "Unknown")
    if not msg:
        return

    readers = json.loads(msg.readers or "[]")
    if username not in readers:
        readers.append(username)
        msg.readers = json.dumps(readers)
        db.session.commit()

    if msg.delete_on_read:
        if not msg.require_all_read:
            if username != msg.username:
                db.session.delete(msg)
                db.session.commit()
                emit("delete_message", {"id": msg_id}, room=msg.room)
                return
        else:
            room_users_set = rooms_users.get(msg.room, set())
            if room_users_set and room_users_set.issubset(set(readers).union({msg.username})):
                db.session.delete(msg)
                db.session.commit()
                emit("delete_message", {"id": msg_id}, room=msg.room)
                return

    if not msg.read:
        msg.read = True
        db.session.commit()
        emit("message_read", {"id": msg.id, "room": msg.room}, room=msg.room)

@socketio.on("typing")
def handle_typing(data):
    room = data.get("room")
    username = users.get(request.sid)
    if room:
        emit("typing", {"user": username}, room=room, include_self=False)

@socketio.on("stop_typing")
def handle_stop_typing(data):
    room = data.get("room")
    username = users.get(request.sid)
    if room:
        emit("stop_typing", {"user": username}, room=room, include_self=False)

UPLOAD_DIR = os.path.join(os.getcwd(), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

@app.route("/upload_chunk", methods=["POST"])
def upload_chunk():
    data = request.get_json()
    file_id = data.get("fileId")
    filename = data.get("filename")
    chunk_index = data.get("chunkIndex")
    iv = data.get("iv")
    chunk = data.get("chunk")

    if not all([file_id, filename, iv, chunk]):
        return jsonify({"success": False, "error": "Missing fields"}), 400

    dir_path = os.path.join(UPLOAD_DIR, file_id)
    os.makedirs(dir_path, exist_ok=True)

    chunk_path = os.path.join(dir_path, f"{chunk_index:05d}.part")
    with open(chunk_path, "wb") as f:
        f.write(base64.b64decode(iv) + base64.b64decode(chunk))

    return jsonify({"success": True})

@app.route("/upload_complete", methods=["POST"])
def upload_complete():
    data = request.get_json()
    file_id = data.get("fileId")
    filename = data.get("filename")

    if not file_id or not filename:
        return jsonify({"success": False, "error": "Missing fileId or filename"}), 400

    dir_path = os.path.join(UPLOAD_DIR, file_id)
    if not os.path.exists(dir_path):
        print("[ERROR] Missing chunks folder:", dir_path)
        return jsonify({"success": False, "error": "Missing chunks"}), 404

    final_path = os.path.join(UPLOAD_DIR, f"{file_id}_{filename}")
    with open(final_path, "wb") as outfile:
        for name in sorted(os.listdir(dir_path)):
            with open(os.path.join(dir_path, name), "rb") as src:
                outfile.write(src.read())

    print("[UPLOAD_COMPLETE] Assembled:", final_path)
    return jsonify({"success": True, "url": f"/uploads/{file_id}_{filename}"})

@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)

# ------------------------------------------------------
# Run server
# ------------------------------------------------------
if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)

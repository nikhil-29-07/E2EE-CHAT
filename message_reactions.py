from flask import Blueprint, request, jsonify
from models import db, MessageReaction

message_reactions = Blueprint('message_reactions', __name__)

@message_reactions.route('/api/messages/<message_id>/react', methods=['POST'])
def react_to_message(message_id):
    from app import socketio  # Late import here to avoid circular import

    data = request.json
    user_id = data.get('user_id')
    emoji = data.get('emoji')
    if not user_id or not emoji:
        return jsonify({'error': 'user_id and emoji required'}), 400
    reaction = MessageReaction(message_id=message_id, user_id=user_id, emoji=emoji)
    db.session.add(reaction)
    db.session.commit()

    socketio.emit('reaction', {'messageId': message_id})

    return jsonify({'status': 'reaction added'})

@message_reactions.route('/api/messages/<message_id>/reactions', methods=['GET'])
def get_message_reactions(message_id):
    reactions = MessageReaction.query.filter_by(message_id=message_id).all()
    result = [
        {
            "id": r.id,
            "user_id": r.user_id,
            "emoji": r.emoji
        }
        for r in reactions
    ]
    return {"reactions": result}

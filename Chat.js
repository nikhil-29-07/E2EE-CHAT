import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import sodium from 'libsodium-wrappers';
import EncryptedSearch from './utils/encryptedSearch';
import ReactionButton from './components/MessageReactions/ReactionButton';

const BACKEND_ORIGIN = 'http://localhost:5000';
const socket = io(BACKEND_ORIGIN);

// Utility crypto helpers
async function generateAndStoreKeyPair() {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();
  const obj = {
    publicKey: sodium.to_base64(keyPair.publicKey),
    privateKey: sodium.to_base64(keyPair.privateKey),
  };
  localStorage.setItem('keyPair', JSON.stringify(obj));
  return obj;
}

async function encryptFor(recipientPublicKeyBase64, textPlain) {
  await sodium.ready;
  const pubBytes = sodium.from_base64(recipientPublicKeyBase64);
  const pt = new TextEncoder().encode(String(textPlain));
  const ct = sodium.crypto_box_seal(pt, pubBytes);
  return sodium.to_base64(ct);
}

async function decryptForMe(ciphertextBase64) {
  await sodium.ready;
  try {
    const keyPair = JSON.parse(localStorage.getItem('keyPair') || 'null');
    if (!keyPair) return "[Encrypted message – not for you]";
    const privateKey = sodium.from_base64(keyPair.privateKey);
    const publicKey = sodium.from_base64(keyPair.publicKey);
    const encryptedBytes = sodium.from_base64(ciphertextBase64);
    const decrypted = sodium.crypto_box_seal_open(encryptedBytes, publicKey, privateKey);
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    return "[Encrypted message – not for you]";
  }
}

// Base64 / AES helpers for uploads
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
async function generateFileKeyBase64() {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  return arrayBufferToBase64(keyBytes.buffer);
}
async function importAesKeyFromBase64(keyBase64) {
  const raw = base64ToArrayBuffer(keyBase64);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encryptChunkWithAes(aesKey, chunkArrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, chunkArrayBuffer);
  return { ivBase64: arrayBufferToBase64(iv.buffer), cipherBase64: arrayBufferToBase64(cipher) };
}

// HTTP helpers for file upload endpoints
async function uploadChunkToServer(fileId, filename, chunkIndex, totalChunks, ivB64, cipherB64) {
  const res = await fetch(`${BACKEND_ORIGIN}/upload_chunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, filename, chunkIndex, totalChunks, iv: ivB64, chunk: cipherB64 })
  });
  if (!res.ok) return null;
  return res.json();
}
async function completeUploadOnServer(fileId, filename) {
  const res = await fetch(`${BACKEND_ORIGIN}/upload_complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, filename })
  });
  if (!res.ok) throw new Error('complete upload failed');
  return res.json();
}

async function downloadAndDecryptAssembledFile(fileUrl, manifest, fileKeyBase64) {
  const res = await fetch(`${BACKEND_ORIGIN}${fileUrl}`);
  if (!res.ok) throw new Error("Fetch failed " + res.status);
  const ab = await res.arrayBuffer();
  if (!manifest || !Array.isArray(manifest) || manifest.length === 0) {
    const bytes = new Uint8Array(ab);
    const iv = bytes.slice(0, 12);
    const cipherBytes = bytes.slice(12).buffer;
    const key = await importAesKeyFromBase64(fileKeyBase64);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBytes);
    const blob = new Blob([plainBuf]);
    return URL.createObjectURL(blob);
  }
  const aesKey = await importAesKeyFromBase64(fileKeyBase64);
  const bytes = new Uint8Array(ab);
  let offset = 0;
  const plainPieces = [];
  for (let i = 0; i < manifest.length; i++) {
    const iv = bytes.slice(offset, offset + 12); offset += 12;
    const cipherLen = manifest[i];
    const cipherBytes = bytes.slice(offset, offset + cipherLen); offset += cipherLen;
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipherBytes.buffer);
    plainPieces.push(new Uint8Array(plainBuf));
  }
  const total = plainPieces.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of plainPieces) { out.set(p, pos); pos += p.byteLength; }
  const blob = new Blob([out]);
  return URL.createObjectURL(blob);
}

export default function Chat() {
  // states
  const [username, setUsername] = useState('');
  const [room, setRoom] = useState('general');
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [allMessages, setAllMessages] = useState([]);
  const [joined, setJoined] = useState(false);
  const [expiryOption, setExpiryOption] = useState('never');
  const [typingUsers, setTypingUsers] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [file, setFile] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const [editMessageId, setEditMessageId] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [e2eeReady, setE2eeReady] = useState(false);
  const [timeTick, setTimeTick] = useState(0);
  const [uploadingState, setUploadingState] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadFileName, setUploadFileName] = useState(null);

  // reactions state
  const [messageReactions, setMessageReactions] = useState({}); // { [msgId]: [{user_id, emoji}] }

  // preview modal state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewName, setPreviewName] = useState(null);

  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  // Reaction emoji array
  const emojis = ["👍", "😂", "❤️", "🔥", "😮"];

  useEffect(() => {
    (async () => {
      try {
        await sodium.ready;
        let kp = JSON.parse(localStorage.getItem('keyPair') || 'null');
        if (!kp) kp = await generateAndStoreKeyPair();
        setE2eeReady(true);
      } catch (e) {
        setE2eeReady(false);
      }
      try { await EncryptedSearch.init?.(); } catch { }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      for (const m of allMessages) {
        try { await EncryptedSearch.indexMessage(m); } catch { }
      }
    })();
  }, [allMessages]);

  useEffect(() => {
    if (messagesEndRef.current) messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const id = setInterval(() => setTimeTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    messages.forEach(m => {
      fetchMessageReactions(m.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    messages.forEach(m => {
      if (m.user !== username && !m.read) {
        socket.emit('message_seen', { id: m.id });
      }
    });
  }, [messages, username]);

  useEffect(() => {
    function onMessage(data) {
      (async () => {
        try {
          const encryptedEntry = data.encrypted_map?.[username];
          let decryptedText = '';
          let fileKeyForMe = null;

          if (encryptedEntry) {
            const dec = await decryptForMe(encryptedEntry);
            try {
              const parsed = JSON.parse(dec);
              decryptedText = parsed.text || '';
              fileKeyForMe = parsed.file_key || null;
            } catch {
              decryptedText = dec;
            }
          } else {
            decryptedText = data.plaintext || '';
          }

          const newMsg = {
            id: data.id || Date.now() + Math.random(),
            user: data.user,
            msg: decryptedText,
            fileUrl: data.fileUrl || null,
            fileName: data.fileName || null,
            file_manifest: data.file_manifest || null,
            file_keys: data.file_keys || null,
            fileKey: fileKeyForMe,
            expires_at: data.expires_at ? new Date(data.expires_at).getTime() : null,
            delivered: data.delivered,
            read: data.read
          };
          await EncryptedSearch.indexMessage(newMsg).catch(() => { });
          setAllMessages(prev => {
            const next = [...prev, newMsg];
            if (!searchActive) setMessages(next);
            return next;
          });
        } catch (err) { }
      })();
    }

    function onStatus(data) {
      const systemMessage = { id: Date.now() + Math.random(), user: 'system', msg: data.msg, expires_at: null };
      setAllMessages(prev => {
        const next = [...prev, systemMessage];
        if (!searchActive) setMessages(next);
        return next;
      });
    }

    function onTyping(data) {
      setTypingUsers(prev => {
        if (data.user && data.user !== username && !prev.includes(data.user)) return [...prev, data.user];
        return prev;
      });
    }
    function onStopTyping(data) {
      setTypingUsers(prev => prev.filter(u => u !== data.user));
    }

    function onOnlineUsers(data) {
      setOnlineUsers(data.users || []);
    }

    socket.on('message', onMessage);
    socket.on('status', onStatus);
    socket.on('typing', onTyping);
    socket.on('stop_typing', onStopTyping);
    socket.on('online_users', onOnlineUsers);

    socket.on('editmessage', async (data) => {
      const encryptedEntry = data.encryptedmap?.[username];
      let decryptedText = '';
      if (encryptedEntry) {
        decryptedText = await decryptForMe(encryptedEntry);
      } else {
        decryptedText = '[Encrypted message – not for you]';
      }
      setAllMessages(prev =>
        prev.map(m =>
          m.id === data.id
            ? { ...m, msg: decryptedText }
            : m
        )
      );
      setMessages(prev =>
        prev.map(m =>
          m.id === data.id
            ? { ...m, msg: decryptedText }
            : m
        )
      );
    });
    socket.on('delete_message', (data) => {
      setAllMessages(prev => prev.filter(m => m.id !== data.id));
      setMessages(prev => prev.filter(m => m.id !== data.id));
    });
    socket.on('message_read', data => {
      setAllMessages(prev =>
        prev.map(m =>
          m.id === data.id ? { ...m, read: true } : m
        )
      );
      setMessages(prev =>
        prev.map(m =>
          m.id === data.id ? { ...m, read: true } : m
        )
      );
    });
    socket.on('reaction', data => {
      if (data.messageId) {
        fetchMessageReactions(data.messageId);  // update reactions for this message
      }
    });
    return () => {
      socket.off('reaction');
    };
    return () => {
      socket.off('message', onMessage);
      socket.off('status', onStatus);
      socket.off('typing', onTyping);
      socket.off('stop_typing', onStopTyping);
      socket.off('online_users', onOnlineUsers);
      socket.off('editmessage');
      socket.off('delete_message');
      socket.off('message_read');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, searchActive]);

  // Search features
  const performSearch = (query) => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setMessages(allMessages);
      setSearchActive(false);
      return;
    }
    const filtered = allMessages.filter(m =>
      (m.user && m.user.toLowerCase().includes(q)) ||
      (m.msg && m.msg.toLowerCase().includes(q)) ||
      (m.fileName && m.fileName.toLowerCase().includes(q))
    );
    setMessages(filtered);
    setSearchActive(true);
  };
  const clearSearch = () => {
    setSearchQuery('');
    setMessages(allMessages);
    setSearchActive(false);
  };

  const deleteMessage = async (id) => {
    try {
      await fetch(`${BACKEND_ORIGIN}/messages/delete/${id}`, { method: 'DELETE' });
      setAllMessages(prev => prev.filter(m => m.id !== id));
      setMessages(prev => prev.filter(m => m.id !== id));
    } catch (e) { }
  };

  const saveEdit = async (id) => {
    try {
      let encryptedMap = {};
      for (const user of onlineUsers) {
        try {
          const publicKey = await fetch(`${BACKEND_ORIGIN}/public-key/${user}`).then(r => r.json()).then(d => d.public_key);
          encryptedMap[user] = await encryptFor(publicKey, editContent);
        } catch {
          encryptedMap[user] = '';
        }
      }
      const res = await fetch(`${BACKEND_ORIGIN}/messages/edit/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted_map: encryptedMap })
      });
      const data = await res.json();
      if (data.success) {
        setEditMessageId(null);
        setEditContent('');
        setAllMessages(prev => prev.map(m => m.id === id ? { ...m, msg: editContent } : m));
        setMessages(prev => prev.map(m => m.id === id ? { ...m, msg: editContent } : m));
      }
    } catch (err) { }
  };

  async function uploadFileResumable(file, progressCb = () => { }) {
    const chunkSize = 256 * 1024;
    const totalSize = file.size;
    const totalChunks = Math.ceil(totalSize / chunkSize);
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const filename = file.name;

    const fileKeyBase64 = await generateFileKeyBase64();
    const aesKey = await importAesKeyFromBase64(fileKeyBase64);

    let uploaded = 0;
    const manifest = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize, end = Math.min(start + chunkSize, totalSize);
      const chunk = file.slice(start, end);
      const chunkArrayBuffer = await chunk.arrayBuffer();
      const { ivBase64, cipherBase64 } = await encryptChunkWithAes(aesKey, chunkArrayBuffer);

      const resp = await uploadChunkToServer(fileId, filename, i, totalChunks, ivBase64, cipherBase64);
      if (!resp || !resp.success) {
        throw new Error(`Chunk upload failed at index ${i}`);
      }
      const cipherLen = (atob(cipherBase64).length);
      manifest.push(cipherLen);
      uploaded += (end - start);
      progressCb(uploaded, totalSize);
    }

    const final = await completeUploadOnServer(fileId, filename);
    if (!final || !final.url) throw new Error('Server failed to assemble uploaded file');

    return { fileUrl: final.url, fileName: filename, fileKeyBase64, manifest };
  }

  const sendMessage = async () => {
    if (!message.trim() && !file) return;

    const expiresAtMs = computeExpiryTs(expiryOption);
    let allRoomUsers = [];

    try {
      const res = await fetch(`${BACKEND_ORIGIN}/room-users/${room}`);
      const data = await res.json();
      allRoomUsers = data.users;
    } catch {
      allRoomUsers = [...onlineUsers];
    }
    if (!allRoomUsers.includes(username)) allRoomUsers.push(username);

    let uploadedMeta = null;
    if (file) {
      try {
        setUploadingState(true);
        setUploadFileName(file.name);
        const result = await uploadFileResumable(file, (uploadedBytes, totalBytes) => {
          setUploadProgress(Math.round((uploadedBytes / totalBytes) * 100));
        });
        uploadedMeta = result;
      } catch (err) {
        setUploadingState(false);
        alert('File upload failed: ' + (err.message || err));
        return;
      } finally {
        setUploadingState(false);
      }
    }

    let encryptedMap = {};
    for (const user of allRoomUsers) {
      try {
        const publicKey = await fetch(`${BACKEND_ORIGIN}/public-key/${user}`).then(r => r.json()).then(d => d.public_key);
        const payload = { text: message || '' };
        if (uploadedMeta) payload.file_key = uploadedMeta.fileKeyBase64;
        const payloadStr = JSON.stringify(payload);
        encryptedMap[user] = await encryptFor(publicKey, payloadStr);
      } catch {
        encryptedMap[user] = '';
      }
    }
    socket.emit('message', {
      room,
      encrypted_map: encryptedMap,
      fileUrl: uploadedMeta ? uploadedMeta.fileUrl : null,
      fileName: uploadedMeta ? uploadedMeta.fileName : null,
      file_manifest: uploadedMeta ? uploadedMeta.manifest : null,
      file_keys: null,
      expires_at: expiresAtMs,
      plaintext: message
    });

    setMessage('');
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setUploadProgress(0);
    setUploadFileName(null);
  };

  const handleTyping = () => {
    socket.emit('typing', { room, username });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => socket.emit('stop_typing', { room, username }), 2000);
  };

  const joinRoom = async () => {
    if (!username || !room) return;
    let kp = JSON.parse(localStorage.getItem('keyPair') || 'null');
    if (!kp) kp = await generateAndStoreKeyPair();
    socket.emit('join', { username, room, publicKey: kp.publicKey });

    try {
      const res = await fetch(`${BACKEND_ORIGIN}/messages/${room}?username=${username}`);
      const data = await res.json();
      const mapped = await Promise.all(data.map(async m => {
        const dec = await decryptForMe(m.encrypted_map?.[username] || '');
        let text = '', fk = null;
        try {
          const parsed = JSON.parse(dec);
          text = parsed.text || '';
          fk = parsed.file_key || null;
        } catch {
          text = dec;
        }
        return {
          id: m.id,
          user: m.username,
          msg: text,
          fileUrl: m.file_url,
          fileName: m.file_name,
          fileKey: fk,
          file_manifest: m.file_manifest || null,
          expires_at: m.expires_at ? new Date(m.expires_at).getTime() : null,
          delivered: m.delivered,
          read: m.read
        };
      }));
      setAllMessages(mapped);
      setMessages(mapped);
    } catch (err) {
      setAllMessages([]);
      setMessages([]);
    }

    try {
      const r2 = await fetch(`${BACKEND_ORIGIN}/room-users/${room}`);
      const d2 = await r2.json();
      setOnlineUsers(d2.users || []);
    } catch (e) { }

    setJoined(true);
  };

  const leaveRoom = () => {
    socket.emit('leave', { username, room });
    setJoined(false);
    setMessages([]);
    setAllMessages([]);
    setOnlineUsers([]);
  };

  const openFilePreview = async (msg) => {
    if (!msg.fileUrl && !msg.fileName) {
      alert('No file available');
      return;
    }
    try {
      let fileKey = msg.fileKey;
      if (!fileKey) {
        const enc = msg.encrypted_map?.[username] || null;
        if (enc) {
          const dec = await decryptForMe(enc);
          try {
            const parsed = JSON.parse(dec);
            if (parsed.file_key) fileKey = parsed.file_key;
          } catch { }
        }
      }
      if (!fileKey) {
        alert('No key available to decrypt this file for you.');
        return;
      }
      const manifest = msg.file_manifest || msg.manifest || null;
      const blobUrl = await downloadAndDecryptAssembledFile(msg.fileUrl, manifest, fileKey);
      setPreviewUrl(blobUrl);
      setPreviewName(msg.fileName || 'file');
      setPreviewOpen(true);
    } catch (err) {
      alert('Failed to decrypt/open file.');
    }
  };

  const closePreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPreviewName(null);
    setPreviewOpen(false);
  };

  function renderExpiryLabel(ts) {
    if (!ts) return 'Never';
    const diff = ts - Date.now();
    if (diff <= 0) return 'Expired';
    const sec = Math.floor(diff / 1000) % 60;
    const mins = Math.floor(diff / 60000) % 60;
    const hours = Math.floor(diff / 3600000) % 24;
    const days = Math.floor(diff / 86400000);
    if (days > 0) return `${days}d ${hours}h ${mins}m ${sec}s`;
    if (hours > 0) return `${hours}h ${mins}m ${sec}s`;
    if (mins > 0) return `${mins}m ${sec}s`;
    return `${sec}s`;
  }

  const fetchMessageReactions = async (messageId) => {
    const res = await fetch(`${BACKEND_ORIGIN}/api/messages/${messageId}/reactions`);
    if (res.ok) {
      const data = await res.json();
      setMessageReactions(prev => ({ ...prev, [messageId]: data.reactions || [] }));
    }
  };
  const handleReaction = async (messageId, emoji) => {
    await fetch(`${BACKEND_ORIGIN}/api/messages/${messageId}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: username, emoji }),
    });
    fetchMessageReactions(messageId);
  };

  return (
    <div style={{ padding: 20 }}>
      {!joined ? (
        <div>
          <h1>Join Chat</h1>
          <div style={{ marginBottom: 8 }}>
            <input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} style={{ width: '100%', padding: 6 }} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <input placeholder="Room" value={room} onChange={e => setRoom(e.target.value)} style={{ width: '100%', padding: 6 }} />
          </div>
          <div>
            <button onClick={joinRoom} style={{ width: '100%', padding: 10 }}>Join</button>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ margin: 0 }}>Room: {room}</h2>
              <div style={{ color: '#666', marginTop: 6 }}>Online Users: {onlineUsers.length > 0 ? onlineUsers.join(', ') : 'None'}</div>
            </div>
            <div>
              <div style={{ marginBottom: 6 }}>
                <span style={{
                  padding: '4px 8px',
                  borderRadius: 5,
                  background: e2eeReady ? '#e6ffed' : '#ffe6e6',
                  color: e2eeReady ? '#2b7a2b' : '#8a1f1f'
                }}>
                  {e2eeReady ? 'Encryption Ready' : 'Encryption Pending'}
                </span>
              </div>
              <div>
                <button onClick={leaveRoom}>Leave</button>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, marginBottom: 12 }}>
            <input
              placeholder="Search messages..."
              value={searchQuery}
              onChange={e => {
                setSearchQuery(e.target.value);
                performSearch(e.target.value);
              }}
              style={{ width: '70%', padding: 6 }}
            />
            <button onClick={() => performSearch(searchQuery)} style={{ marginLeft: 8 }}>Search</button>
            <button onClick={() => {
              setSearchQuery('');
              setMessages(allMessages);
              setSearchActive(false);
            }} style={{ marginLeft: 8 }}>Clear</button>
          </div>

          <div style={{ border: '1px solid #aaa', height: 420, overflowY: 'auto', padding: 10, background: '#fff' }}>
            {messages.length === 0 && (
              <div style={{ color: '#888', padding: 10 }}>
                No messages yet.
              </div>
            )}
            {messages.map((m, idx) => (
              <div key={m.id || idx} style={{ padding: 8, borderBottom: '1px solid #eee' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div style={{ fontWeight: m.user === 'system' ? 'normal' : 'bold', color: m.user === 'system' ? '#666' : (m.user === username ? '#0050a0' : '#000') }}>
                    {m.user}
                  </div>
                  <div style={{ fontSize: 12, color: '#666' }}>
                    {m.expires_at ? renderExpiryLabel(m.expires_at) : 'Never'}
                  </div>
                </div>
                <div style={{ marginTop: 6 }}>
                  {editMessageId === m.id ? (
                    <>
                      <textarea
                        value={editContent}
                        onChange={e => setEditContent(e.target.value)}
                        style={{ width: '100%', minHeight: 60, fontSize: 14, padding: 4 }}
                      />
                      <div style={{ marginTop: 4 }}>
                        <button onClick={() => saveEdit(m.id)}>Save</button>
                        <button onClick={() => { setEditMessageId(null); setEditContent(''); }} style={{ marginLeft: 8 }}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.msg}</div>
                  )}

                  {m.user === username && (
                    <div style={{ fontSize: 12, marginTop: 2, color: '#555' }}>
                      {m.read
                        ? <span title="Read">&#10003;&#10003;</span>
                        : m.delivered
                          ? <span title="Delivered">&#10003;</span>
                          : <span title="Sent">&#9675;</span>
                      }
                    </div>
                  )}
                </div>

                {m.fileUrl && (
                  <div style={{ marginTop: 8 }}>
                    {m.fileUrl.match(/\.(jpeg|jpg|gif|png)$/i) ? (
                      <button onClick={() => openFilePreview(m)}>Preview / Open Image</button>
                    ) : (
                      <button onClick={() => openFilePreview(m)}>Download / Open File</button>
                    )}
                  </div>
                )}

                {/* Reaction Buttons */}
                <div style={{ marginTop: 8 }}>
                  {emojis.map((emoji) => (
                    <ReactionButton
                      key={emoji}
                      emoji={emoji}
                      onClick={() => handleReaction(m.id, emoji)}
                    />
                  ))}
                </div>
                {/* Show current reactions for this message */}
                <div style={{ marginTop: 4 }}>
                  {(messageReactions[m.id] || []).map((r, i) => (
                    <span key={i} style={{ marginRight: 8, fontSize: 16 }}>
                      {r.emoji} <span style={{ fontSize: 12, color: "#888" }}>{r.user_id}</span>
                    </span>
                  ))}
                </div>

                <div style={{ marginTop: 8, fontSize: 12 }}>
                  {m.user === username && (
                    <>
                      <button onClick={() => { setEditMessageId(m.id); setEditContent(m.msg); }}>Edit</button>
                      <button style={{ marginLeft: 8 }} onClick={() => deleteMessage(m.id)}>Delete</button>
                    </>
                  )}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
            {typingUsers.length > 0 && <div style={{ padding: 8, color: '#777' }}>{typingUsers.join(', ')} typing...</div>}
          </div>

          {uploadingState && (
            <div style={{ marginTop: 8 }}>
              Uploading <b>{uploadFileName}</b>: {uploadProgress}% complete
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <input type="file" ref={fileInputRef} onChange={e => setFile(e.target.files[0])} />
            <input placeholder="Message" value={message} onChange={e => { setMessage(e.target.value); handleTyping(); }}
              onKeyPress={e => e.key === 'Enter' && sendMessage()} style={{ flex: 1, padding: 8 }} />
            <select value={expiryOption} onChange={e => setExpiryOption(e.target.value)}>
              <option value="never">Never</option>
              <option value="1h">1 hour</option>
              <option value="1d">1 day</option>
              <option value="1w">1 week</option>
            </select>
            <button onClick={sendMessage} disabled={!joined}>Send</button>
          </div>
        </div>
      )}

      {previewOpen && previewUrl && (
        <div style={{
          position: 'fixed', left: 0, top: 0, width: '100%', height: '100%',
          background: 'rgba(0,0,0,0.7)', display: 'flex', justifyContent: 'center', alignItems: 'center',
          zIndex: 9999
        }}>
          <div style={{ width: '80%', height: '80%', background: '#fff', padding: 12, borderRadius: 6, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 'bold' }}>{previewName}</div>
              <div>
                <button onClick={() => { closePreview(); }}>Close</button>
              </div>
            </div>
            <div style={{ flex: 1, marginTop: 8, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {/\.(jpg|jpeg|png|gif|webp)$/i.test(previewName) && <img src={previewUrl} alt="preview" style={{ maxWidth: '100%', maxHeight: '100%' }} />}
              {/\.pdf$/i.test(previewName) && <iframe src={previewUrl} title="pdf" style={{ width: '100%', height: '100%' }} />}
              {/\.txt$|\.md$|\.log$/i.test(previewName) && <iframe src={previewUrl} title="txt" style={{ width: '100%', height: '100%' }} />}
              {!(/\.(jpg|jpeg|png|gif|webp|pdf|txt|md|log)$/i.test(previewName)) && (
                <div>
                  <p>Cannot preview this file type. You can download it:</p>
                  <a href={previewUrl} download={previewName}>Download</a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  function computeExpiryTs(option) {
    if (!option || option === 'never') return null;
    const now = Date.now();
    if (option === '1h') return now + (60 * 60 * 1000);
    if (option === '1d') return now + (24 * 60 * 60 * 1000);
    if (option === '1w') return now + (7 * 24 * 60 * 60 * 1000);
    return null;
  }
}

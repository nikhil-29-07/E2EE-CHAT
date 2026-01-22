import React, { useState } from 'react';

function GhostRoom({ username, onEnterRoom }) {
  const [roomName, setRoomName] = useState('');

  const handleJoin = () => {
    const r = (roomName || '').trim();
    if (!r) {
      alert('Enter a room name (share this with the person you want to chat with).');
      return;
    }
    onEnterRoom(r);
  };

  return (
    <div style={{ maxWidth: 600, margin: 'auto', padding: 20, color: '#eee', background: '#000', minHeight: '100vh' }}>
      <h2 style={{ color: '#ff6b6b' }}>Ghost Room — Private</h2>
      <p style={{ color: '#bbb' }}>
        You are <b>{username}</b>. Enter a private ghost room name. Share this room name privately with who you want to chat.
      </p>

      <div style={{ marginTop: 20 }}>
        <input
          placeholder="private-room-name"
          value={roomName}
          onChange={e => setRoomName(e.target.value)}
          style={{ padding: 10, width: '70%', borderRadius: 6, border: '1px solid #333', background: '#111', color: '#fff' }}
        />
        <button onClick={handleJoin} style={{ marginLeft: 8, padding: '10px 14px', background: '#ff6b6b', color: '#fff', border: 'none', borderRadius: 6 }}>
          Join
        </button>
      </div>

      <div style={{ marginTop: 18, color: '#999' }}>
        <small>Tip: choose a unique name and share it only with the intended person(s).</small>
      </div>
    </div>
  );
}

export default GhostRoom;

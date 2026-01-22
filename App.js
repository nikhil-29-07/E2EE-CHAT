import React, { useState } from 'react';
import Login from './Login';
import Chat from './Chat';
import GhostRoom from './GhostRoom';
import GhostChat from './GhostChat';

function App() {
  const [username, setUsername] = useState(null);
  const [isGhost, setIsGhost] = useState(false);
  const [ghostRoom, setGhostRoom] = useState(null);

  if (!username) {
    return (
      <Login
        onLoginSuccess={(user, ghostMode) => {
          setUsername(user);
          setIsGhost(Boolean(ghostMode));
          setGhostRoom(null);
        }}
      />
    );
  }

  // If guest logged in but hasn't selected room yet → show room selector
  if (isGhost && !ghostRoom) {
    return (
      <GhostRoom
        username={username}
        onEnterRoom={(roomName) => setGhostRoom(roomName)}
      />
    );
  }

  if (isGhost && ghostRoom) {
    return <GhostChat username={username} room={ghostRoom} />;
  }

  // Normal logged-in user goes to normal Chat
  return <Chat username={username} />;
}

export default App;

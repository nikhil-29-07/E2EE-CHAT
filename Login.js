import React, { useState } from 'react';
import sodium from 'libsodium-wrappers';

function Login({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [isSignup, setIsSignup] = useState(false);
  const [error, setError] = useState('');

  async function getOrCreateKeyPair() {
    await sodium.ready;
    let keyPair = JSON.parse(localStorage.getItem('keyPair'));
    if (!keyPair) {
      const sodiumKeyPair = sodium.crypto_box_keypair();
      keyPair = {
        publicKey: sodium.to_base64(sodiumKeyPair.publicKey),
        privateKey: sodium.to_base64(sodiumKeyPair.privateKey)
      };
      localStorage.setItem('keyPair', JSON.stringify(keyPair));
    }
    return keyPair;
  }

  const BACKEND = process.env.REACT_APP_BACKEND_URL || 'http://localhost:5000';

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    const keyPair = await getOrCreateKeyPair();

    const endpoint = isSignup ? '/signup' : '/login';
    const body = isSignup
      ? { email, password, username: usernameInput, public_key: keyPair.publicKey }
      : { email, password, public_key: keyPair.publicKey };

    try {
      const res = await fetch(`${BACKEND}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        // normal login → not ghost
        onLoginSuccess(data.username || usernameInput || data.username, false);
      } else {
        setError(data.error || 'Error');
      }
    } catch (err) {
      setError('Network error');
    }
  };

  // Anonymous / Guest login (redirects to ghost flow)
  const handleAnonymousLogin = async () => {
    setError('');
    const keyPair = await getOrCreateKeyPair();
    const BACKEND = process.env.REACT_APP_BACKEND_URL || 'http://localhost:5000';
    try {
      const res = await fetch(`${BACKEND}/anonymous-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_key: keyPair.publicKey }),
        credentials: 'include'
      });
      const data = await res.json();
      if (res.ok) {
        // Guest login → pass ghostMode = true
        onLoginSuccess(data.username || 'anon_guest', true);
      } else {
        setError(data.error || 'Error logging in anonymously');
      }
    } catch (err) {
      setError('Network error (anonymous login)');
    }
  };

  return (
    <div style={{ maxWidth: 420, margin: 'auto', padding: 20 }}>
      <h2>{isSignup ? 'Signup' : 'Login'}</h2>
      <form onSubmit={handleSubmit}>
        {isSignup && (
          <input
            placeholder="Username"
            value={usernameInput}
            onChange={e => setUsernameInput(e.target.value)}
            required
          />
        )}
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
        />
        <div style={{ marginTop: 8 }}>
          <button type="submit">{isSignup ? 'Sign up' : 'Log in'}</button>
        </div>
      </form>

      <div style={{ marginTop: 12 }}>
        <button onClick={() => setIsSignup(!isSignup)}>
          {isSignup ? 'Have an account? Log in' : 'New user? Sign up'}
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <button onClick={handleAnonymousLogin}>Login as Guest</button>
      </div>

      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}

export default Login;

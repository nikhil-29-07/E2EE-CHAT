// GhostChat.js — updated, full file
import React, { useState, useEffect, useRef } from "react";
import io from "socket.io-client";
import sodium from "libsodium-wrappers";

const socket = io("http://localhost:5000", {
  transports: ["websocket"],
});

export default function GhostChat({ username, room }) {
  const [messages, setMessages] = useState([]); // message objects { id, serverId, user, msg, plaintext, removing, isLocal }
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [input, setInput] = useState("");

  const listRef = useRef(null);
  const observerRef = useRef(null);

  // SCROLL helper
  const scrollToBottom = () => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  };

  // local decrypt helper
  async function decryptMessageBase64(cipher) {
    if (!cipher) return "[Not for you]";
    try {
      await sodium.ready;
      const kp = JSON.parse(localStorage.getItem("keyPair") || "{}");
      if (!kp.privateKey || !kp.publicKey) return "[Not for you]";
      const privateKey = sodium.from_base64(kp.privateKey);
      const publicKey = sodium.from_base64(kp.publicKey);
      const enc = sodium.from_base64(cipher);
      const dec = sodium.crypto_box_seal_open(enc, publicKey, privateKey);
      return new TextDecoder().decode(dec);
    } catch (e) {
      // Not intended for this user or decryption fail
      return "[Not for you]";
    }
  }

  // compute lifetime by reading-time (0.5s/word, min 3s, max 15s)
  const computeLifetime = (text) => {
    const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
    let ms = Math.round(words * 500); // 0.5s per word
    if (ms < 3000) ms = 3000;
    if (ms > 15000) ms = 15000;
    return ms;
  };

  // Observer callback — uses functional state updates to avoid stale closures
  const handleIntersect = (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const id = entry.target.dataset.msgid;
      if (!id) return;

      // Use functional update so we read current state
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) return prev;
        const msgObj = prev[idx];
        if (msgObj.removing) return prev;

        // mark removing
        const updated = prev.map((m) => (m.id === id ? { ...m, removing: true } : m));

        // tell server message seen (delete-on-read)
        if (msgObj.serverId) {
          try {
            socket.emit("message_seen", { id: msgObj.serverId });
          } catch { /* ignore */ }
        }

        // schedule actual removal after reading-time
        const lifetime = computeLifetime(msgObj.plaintext || msgObj.msg || "");
        setTimeout(() => {
          setMessages((cur) => cur.filter((c) => c.id !== id));
        }, lifetime);

        return updated;
      });
    });
  };

  // SEND message — placed before return so it's callable
  async function sendMessage() {
    if (!input.trim()) return;

    // show immediate local message
    const localId = "local-" + Date.now();
    const preview = {
      id: localId,
      serverId: null,
      user: username,
      msg: input,
      plaintext: input,
      removing: false,
      isLocal: true,
    };
    setMessages((prev) => [...prev, preview]);
    setInput("");
    scrollToBottom();

    // Build placeholder encrypted_map (your app can replace with real encryption)
    const encrypted_map = {};
    (onlineUsers || []).forEach((u) => (encrypted_map[u] = ""));

    // emit to server (include plaintext so server can moderate or do delete-on-read logic)
    socket.emit("message", {
      room,
      encrypted_map,
      plaintext: preview.plaintext,
    });
  }

  // SETUP socket and observer once per mounted chat
  useEffect(() => {
    // create observer with root = listRef.current
    observerRef.current = new IntersectionObserver(handleIntersect, {
      root: listRef.current || null,
      threshold: 0.5,
    });

    // join room
    const kp = JSON.parse(localStorage.getItem("keyPair") || "{}");
    socket.emit("join", { username, room, publicKey: kp.publicKey });

    // dedupe helpers
    const seenSystem = new Set();

    // handle incoming server messages
    const handleMessage = async (data) => {
      // ignore if wrong room
      if (data.room && data.room !== room) return;

      // prefer server-provided plaintext (fast path) otherwise decrypt
      let plain = data.plaintext || "";
      if (!plain) {
        const cipher = data.encrypted_map?.[username];
        plain = cipher ? await decryptMessageBase64(cipher) : "[Not for you]";
      }

      const serverMsg = {
        id: "srv-" + data.id,
        serverId: data.id,
        user: data.user,
        plaintext: plain,
        msg: plain,
        removing: false,
      };

      // If there's a matching local preview, replace it (avoid duplicates).
      setMessages((prev) => {
        // find local preview with same plaintext & same user (best-effort)
        const localIndex = prev.findIndex((m) => m.isLocal && m.user === data.user && m.msg === serverMsg.msg);
        if (localIndex !== -1) {
          // replace preview with server message (keep order)
          const copy = prev.slice();
          copy[localIndex] = serverMsg;
          return copy;
        }

        // If a same serverId already exists, skip
        if (prev.some((m) => m.serverId === serverMsg.serverId)) return prev;

        return [...prev, serverMsg];
      });

      // small scroll
      setTimeout(scrollToBottom, 40);
    };

    // system/status
    const handleStatus = (data) => {
      if (!data?.msg) return;
      if (seenSystem.has(data.msg)) return;
      seenSystem.add(data.msg);
      const sys = {
        id: "sys-" + Date.now() + "-" + Math.random(),
        user: "system",
        msg: data.msg,
        removing: false,
      };
      setMessages((prev) => [...prev, sys]);
      setTimeout(scrollToBottom, 20);
    };

    // delete message from server
    const handleDelete = ({ id }) => {
      setMessages((prev) => prev.filter((m) => m.serverId !== id));
    };

    // online users update
    const handleOnline = (data) => {
      setOnlineUsers(data.users || []);
    };

    socket.on("message", handleMessage);
    socket.on("status", handleStatus);
    socket.on("delete_message", handleDelete);
    socket.on("online_users", handleOnline);

    // cleanup on unmount
    return () => {
      socket.off("message", handleMessage);
      socket.off("status", handleStatus);
      socket.off("delete_message", handleDelete);
      socket.off("online_users", handleOnline);
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, username]);

  // Observe elements when messages change: attach observer to visible DOM nodes
  useEffect(() => {
    if (!observerRef.current || !listRef.current) return;
    const root = listRef.current;
    // Find current message nodes and observe them (only those not yet observed)
    const nodes = root.querySelectorAll("[data-msgid]");
    nodes.forEach((node) => {
      try {
        observerRef.current.observe(node);
      } catch {}
    });
  }, [messages]);

  // render
  return (
    <div style={{ background: "#000", color: "#fff", height: "100vh", padding: 20 }}>
      <h1 style={{ textAlign: "center", color: "#ff4c4c" }}>Ghost Room</h1>
      <div style={{ textAlign: "center", color: "#bbb" }}>
        Room: {room} • You: {username}
      </div>

      <div style={{ display: "flex", gap: 20, marginTop: 20 }}>
        {/* Messages */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            height: "70vh",
            overflowY: "auto",
            padding: 10,
            background: "#111",
            borderRadius: 8,
          }}
        >
          {messages.map((m) => (
            <div
              key={m.id}
              data-msgid={m.id}
              style={{
                padding: "10px",
                marginBottom: 8,
                background: m.user === "system" ? "#333" : "#222",
                borderRadius: 5,
                opacity: m.removing ? 0.4 : 1,
                transition: "opacity 0.4s",
                color: "#eee",
              }}
            >
              <b style={{ color: "#aaa" }}>{m.user}:</b> {m.msg}
            </div>
          ))}
        </div>

        {/* Online users */}
        <div
          style={{
            width: 220,
            padding: 10,
            background: "#111",
            borderRadius: 8,
            height: "70vh",
            overflowY: "auto",
          }}
        >
          <h3 style={{ color: "#ccc" }}>Online</h3>
          {onlineUsers.map((u) => (
            <div key={u} style={{ padding: "6px 0", color: "#ddd" }}>
              {u}
            </div>
          ))}
        </div>
      </div>

      {/* input row */}
      <div style={{ marginTop: 15, display: "flex", gap: 10 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type (messages auto-delete after reading)…"
          style={{
            flex: 1,
            padding: 10,
            background: "#111",
            color: "#fff",
            borderRadius: 5,
            border: "1px solid #444",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendMessage();
          }}
        />
        <button
          onClick={sendMessage}
          style={{
            background: "#ff4c4c",
            padding: "10px 18px",
            borderRadius: 5,
            color: "#fff",
            border: "none",
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

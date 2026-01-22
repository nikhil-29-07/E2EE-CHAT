import React from 'react';

const ReactionButton = ({ emoji, onClick }) => {
  return (
    <button 
      onClick={() => onClick(emoji)} 
      style={{ fontSize: "20px", margin: "2px", cursor: "pointer", border: "none", background: "transparent" }}
      aria-label={`React with ${emoji}`}
    >
      {emoji}
    </button>
  );
};

export default ReactionButton;

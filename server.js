const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
  res.send('Bingo demo server is running');
});

// ገና ያልተጠሩ ቁጥሮች (1-75)
let remainingNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
let calledNumbers = [];

function callNextNumber() {
  if (remainingNumbers.length === 0) {
    console.log('ሁሉም ቁጥሮች ተጠርተዋል');
    return;
  }
  const randomIndex = Math.floor(Math.random() * remainingNumbers.length);
  const number = remainingNumbers.splice(randomIndex, 1)[0];
  calledNumbers.push(number);
  console.log('ቁጥር ተጠራ:', number);
  io.emit('number_called', { number, calledNumbers });
}

io.on('connection', (socket) => {
  console.log('አዲስ ተጫዋች ገባ:', socket.id);
  // አዲስ ገቢ ተጫዋች እስካሁን የተጠሩትን ቁጥሮች ይቀበላል
  socket.emit('game_state', { calledNumbers });

  socket.on('disconnect', () => {
    console.log('ተጫዋች ወጣ:', socket.id);
  });
});

// በየ5 ሰከንድ አዲስ ቁጥር ይጠራል (ለሙከራ ብቻ)
setInterval(callNextNumber, 5000);

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

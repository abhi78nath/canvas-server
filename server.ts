import { Server, Socket } from "socket.io";
import express from "express";
import { createServer } from "http";
import validator from "validator";
import { registerChatHandlers } from "./chat";
import { createRoundManager } from "./game-logic/game-logic";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Per-room state
type RoomState = {
  currentDrawer: string | null;
  drawEvents: CanvasEvent[];
  users: Map<string, { username: string; score: number; isDrawing: boolean }>;
  roundNumber: number;
  currentWord: string;
  ownerId: string | null;
  drawerOrder: string[];
  currentDrawerIndex: number;
  roundTimer: NodeJS.Timeout | null;
  wordChoiceTimer: NodeJS.Timeout | null;
  roundInProgress: boolean;
  roundEndsAt?: number;
  wordChoiceEndsAt?: number;
};

type BeginPathEvent = { type: "beginPath"; userId: string; x: number; y: number };
type DrawEvent = {
  type: "draw";
  userId: string;
  x: number;
  y: number;
  color: string;
  size: number;
};
type CanvasEvent = BeginPathEvent | DrawEvent;

const rooms = new Map<string, RoomState>();
const socketRoom = new Map<string, string>();

function getRoomState(room: string): RoomState {
  let state = rooms.get(room);
  if (!state) {
    state = {
      currentDrawer: null,
      drawEvents: [],
      users: new Map(),
      roundNumber: 1,
      currentWord: "",
      ownerId: null,
      drawerOrder: [],
      currentDrawerIndex: 0,
      roundTimer: null,
      wordChoiceTimer: null,
      roundInProgress: false,
    };
    rooms.set(room, state);
  }
  return state;
}

// Throttle draw events
const throttle = (fn: Function, limit: number) => {
  let lastCall = 0;
  return (...args: any[]) => {
    const now = Date.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      fn(...args);
    }
  };
};

io.on("connection", (socket: Socket) => {
  console.log("User connected:", socket.id);

  const roundManager = createRoundManager(io, (roomId) => getRoomState(roomId));

  socket.on("joinRoom", ({ room, name }: { room: string; name: string }, callback) => {
    const roomId = (room || "lobby").trim().toLowerCase();
    const username = validator.escape(name.trim());

    if (!roomId || roomId.length > 50 || !validator.isAlphanumeric(roomId, "en-US", { ignore: "-" })) {
      return callback?.({ error: "Invalid room ID" });
    }
    if (!username || username.length < 2 || username.length > 20) {
      return callback?.({ error: "Username must be 2-20 characters" });
    }

    const state = getRoomState(roomId);
    if (state.users.size >= 8) {
      return callback?.({ error: "Room is full" });
    }

    // Handle reconnect: update socketId if username exists
    let existingSocketId: string | null = null;
    for (const [sid, user] of state.users.entries()) {
      if (user.username.toLowerCase() === username.toLowerCase()) {
        existingSocketId = sid;
        break;
      }
    }
    if (existingSocketId) {
      state.users.delete(existingSocketId);
      socketRoom.delete(existingSocketId);
      if (state.currentDrawer === existingSocketId) {
        state.currentDrawer = null;
        io.to(roomId).emit("drawRevoked");
      }
    }

    socket.join(roomId);
    socketRoom.set(socket.id, roomId);
    state.users.set(socket.id, { username, score: 0, isDrawing: false });
    roundManager.onUserJoin(roomId, socket.id);

    io.to(roomId).emit("userJoined", username);
    roundManager.broadcastParticipants(roomId);

    callback?.({ success: true, roomId, playerId: socket.id });
    console.log(`${username} joined ${roomId}`);

    // Start rotation when there are at least two users
    roundManager.startRotationIfEligible(roomId);
  });

  socket.on("wordChosen", ({ word }: { word: string }) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const state = getRoomState(roomId);
    if (state.currentDrawer !== socket.id) return;
    state.currentWord = word;
    roundManager.startMainRoundTimer(roomId);
    io.to(roomId).emit("wordHint", "_ ".repeat(word.length).trim());
  });

  // Chat handlers need access to current room and username
  registerChatHandlers(io, socket, {
    getRoomId: () => socketRoom.get(socket.id),
    getUsername: () => {
      const room = socketRoom.get(socket.id);
      if (!room) return undefined;
      const state = getRoomState(room);
      return state.users.get(socket.id)?.username;
    },
  });

  const throttledDraw = throttle((data: any) => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    if (!roundManager.isCurrentDrawer(room, socket.id)) return;
    const payload: DrawEvent = {
      type: "draw",
      userId: socket.id,
      x: data.x,
      y: data.y,
      color: data.color,
      size: data.size,
    };
    state.drawEvents.push(payload);
    socket.to(room).emit("draw", payload);
  }, 50);

  socket.on("beginPath", (data) => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    if (!roundManager.isCurrentDrawer(room, socket.id)) return;
    const payload: BeginPathEvent = { type: "beginPath", userId: socket.id, x: data.x, y: data.y };
    state.drawEvents.push(payload);
    socket.to(room).emit("beginPath", payload);
  });

  socket.on("draw", throttledDraw);

  socket.on("clear", () => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    if (!roundManager.isCurrentDrawer(room, socket.id)) return;
    state.drawEvents.length = 0;
    socket.to(room).emit("clear");
  });

  socket.on("requestCanvasState", () => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    socket.emit("canvasState", state.drawEvents);
    if (state.currentDrawer) {
      // Don't emit drawGranted here on join, wait for round to start
      // socket.emit("drawGranted", state.currentDrawer);
    }
  });

  socket.on("requestParticipants", () => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    roundManager.broadcastParticipants(room);
  });

  socket.on("requestDraw", () => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    if (!state.currentDrawer) {
      state.currentDrawer = socket.id;
      state.users.get(socket.id)!.isDrawing = true;
      io.to(room).emit("drawGranted", socket.id);
    }
  });

  socket.on("releaseDraw", () => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    if (state.currentDrawer === socket.id) {
      state.currentDrawer = null;
      state.users.get(socket.id)!.isDrawing = false;
      io.to(room).emit("drawRevoked");
    }
  });

  socket.on("disconnect", () => {
    const room = socketRoom.get(socket.id);
    if (!room) {
      console.log(`No room found for disconnected socket: ${socket.id}`);
      return;
    }
    socketRoom.delete(socket.id);
    const state = getRoomState(room);
    const user = state.users.get(socket.id);
    if (user) {
      console.log(`${user.username} disconnected from ${room}`);
      // Update rotation lists and owner if needed
      roundManager.onUserLeft(room, socket.id);
      state.users.delete(socket.id);
      io.to(room).emit("userLeft", user.username);
      // If drawer left mid-round, rotate to next; otherwise just update participants/draw state
      if (state.currentDrawer === socket.id && state.roundInProgress) {
        roundManager.rotateToNext(room);
      } else {
        if (state.currentDrawer === socket.id) {
          state.currentDrawer = null;
          for (const [, u] of state.users.entries()) u.isDrawing = false;
          io.to(room).emit("drawRevoked");
        }
        roundManager.broadcastParticipants(room);
        // If after disconnect we now have >=2 users and no round in progress, start one
        roundManager.startRotationIfEligible(room);
      }
      if (state.users.size === 0) {
        console.log(`Room ${room} is empty, deleting`);
        rooms.delete(room);
      }
    } else {
      console.warn(`No user found for socket: ${socket.id} in room: ${room}`);
    }
  });
});

const PORT = process.env.PORT || 4001;
httpServer.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});
import { Server } from "socket.io";
import express from "express";
import { createServer } from "http";

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
  users: Map<string, string>; // socketId -> name
};

// Persist a simple event log to reconstruct the canvas for late joiners per room
// We reset this on clear; each event contains the originating user for path continuity
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
const socketRoom = new Map<string, string>(); // socketId -> room

function getRoomState(room: string): RoomState {
  let state = rooms.get(room);
  if (!state) {
    state = { currentDrawer: null, drawEvents: [], users: new Map() };
    rooms.set(room, state);
  }
  return state;
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // User joins a specific room with a name
  socket.on("joinRoom", ({ room, name }: { room: string; name: string }) => {
    const r = (room || "lobby").trim() || "lobby";
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    socket.join(r);
    socketRoom.set(socket.id, r);
    const state = getRoomState(r);
    state.users.set(socket.id, trimmed);
    io.to(r).emit("userJoined", trimmed);
    io.to(r).emit("participants", Array.from(state.users.values()));
  });

  socket.on("beginPath", (data) => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    const payload: BeginPathEvent = { type: "beginPath", userId: socket.id, x: data.x, y: data.y };
    state.drawEvents.push(payload);
    socket.to(room).emit("beginPath", payload);
  });

  socket.on("draw", (data) => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
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
  });

  socket.on("clear", () => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    // Reset server-side state and inform everyone in the room
    state.drawEvents.length = 0;
    socket.to(room).emit("clear");
  });

  // Late joiners can request the current canvas state
  socket.on("requestCanvasState", () => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    socket.emit("canvasState", state.drawEvents);
    if (state.currentDrawer) {
      socket.emit("drawGranted", state.currentDrawer);
    }
  });

  // Request current participants list
  socket.on("requestParticipants", () => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    socket.emit("participants", Array.from(state.users.values()));
  });

  socket.on("requestDraw", () => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    if (!state.currentDrawer) {
      console.log("User requesting draw rights:", socket.id, "room:", room);
      state.currentDrawer = socket.id;
      io.to(room).emit("drawGranted", socket.id);
    }
  });

  socket.on("releaseDraw", () => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    const state = getRoomState(room);
    if (state.currentDrawer === socket.id) {
      state.currentDrawer = null;
      io.to(room).emit("drawRevoked");
    }
  });

  socket.on("disconnect", () => {
    const room = socketRoom.get(socket.id);
    if (!room) return;
    socketRoom.delete(socket.id);
    const state = getRoomState(room);
    const name = state.users.get(socket.id);
    if (name) {
      state.users.delete(socket.id);
      io.to(room).emit("userLeft", name);
      io.to(room).emit("participants", Array.from(state.users.values()));
    }
    if (state.currentDrawer === socket.id) {
      state.currentDrawer = null;
      io.to(room).emit("drawRevoked");
    }
  });
});

const PORT = process.env.PORT || 4001;
httpServer.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});

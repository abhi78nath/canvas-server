import { Server, Socket } from "socket.io";
import express from "express";
import { createServer } from "http";
import validator from "validator";
import { registerChatHandlers } from "./chat";
import { createRoundManager } from "./game-logic/game-logic";
import { calculateGuesserScore } from "./game-logic/point-system";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Global CORS for REST endpoints
app.use((req, res, next) => {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
	res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
	if (req.method === "OPTIONS") {
		return res.sendStatus(204);
	}
	next();
});

// Per-room state
type RoomState = {
  currentDrawer: string | null;
  drawEvents: CanvasEvent[];
  users: Map<string, { username: string; score: number; isDrawing: boolean }>;
  roundNumber: number;
  totalRounds: number;
  currentWord: string;
  ownerId: string | null;
  drawerOrder: string[];
  currentDrawerIndex: number;
  roundTimer: NodeJS.Timeout | null;
  wordChoiceTimer: NodeJS.Timeout | null;
  hintTimer: NodeJS.Timeout | null;
  roundInProgress: boolean;
  roundEndsAt?: number;
  wordChoiceEndsAt?: number;
  revealedIndices: Set<number>;
  correctGuessers: string[];
  lastGuessTime: number | null;
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
      totalRounds: 3,
      currentWord: "",
      ownerId: null,
      drawerOrder: [],
      currentDrawerIndex: 0,
      roundTimer: null,
      wordChoiceTimer: null,
      hintTimer: null,
      roundInProgress: false,
      revealedIndices: new Set(),
      correctGuessers: [],
      lastGuessTime: null,
    };
    rooms.set(room, state);
  }
  return state;
}

// Matchmaking helpers
function generateRoomId(): string {
  // Generate a short, URL-safe lowercase id that matches existing validation (alphanumeric and '-')
  let id: string;
  do {
    id = `room-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
  } while (rooms.has(id));
  return id;
}

function pickRandomJoinableRoomId(): string | undefined {
  const candidates: string[] = [];
  for (const [id, state] of rooms.entries()) {
    if (state.users.size < 8) candidates.push(id);
  }
  if (candidates.length === 0) return undefined;
  const idx = Math.floor(Math.random() * candidates.length);
  return candidates[idx];
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

// REST endpoint: proxy RandomUser API
app.get("/api/random-user", async (req, res) => {
	try {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Vary", "Origin");
		const { results, gender, nat, seed, inc, exc, page } = req.query as Record<string, string | undefined>;
		const params = new URLSearchParams();
		if (results) params.set("results", results);
		if (gender) params.set("gender", gender);
		if (nat) params.set("nat", nat);
		if (seed) params.set("seed", seed);
		if (inc) params.set("inc", inc);
		if (exc) params.set("exc", exc);
		if (page) params.set("page", page);

		const url = `https://randomuser.me/api/${params.toString() ? `?${params.toString()}` : ""}`;
		const response = await fetch(url, {
			headers: {
				"User-Agent": "CollaborativeApp/1.0 (+https://localhost)",
				"Accept": "application/json",
			},
		});
		if (!response.ok) {
			return res.status(response.status).json({ error: "Upstream RandomUser error", status: response.status });
		}
		const data = await response.json();
		console.log("RandomUser data:", data?.results?.[0]?.login?.username);
		res.setHeader("Cache-Control", "no-store");
		return res.json(data?.results?.[0]?.login?.username);
	} catch (error) {
		console.error("RandomUser fetch failed:", error);
		return res.status(500).json({ error: "Failed to fetch random user", username: null });
	}
});

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
      if (existingSocketId !== socket.id) {
        // Clean up previous connection that used the same username (treat as reconnect/duplicate name)
        const previousUser = state.users.get(existingSocketId);
        state.users.delete(existingSocketId);
        socketRoom.delete(existingSocketId);
        if (state.currentDrawer === existingSocketId) {
          state.currentDrawer = null;
          io.to(roomId).emit("drawRevoked");
        }
        // Notify room that the previous user left and fully disconnect their socket
        if (previousUser) {
          io.to(roomId).emit("userLeft", previousUser.username);
        }
        const oldSocket = io.sockets.sockets.get(existingSocketId);
        if (oldSocket) {
          try {
            oldSocket.leave(roomId);
          } catch {}
          oldSocket.disconnect(true);
        }
      }
    }

    socket.join(roomId);
    socketRoom.set(socket.id, roomId);
    state.users.set(socket.id, { username, score: 0, isDrawing: false });
    roundManager.onUserJoin(roomId, socket.id);

    if (state.roundInProgress) {
      socket.emit("newRound", {
        roundNumber: state.roundNumber,
        totalRounds: state.totalRounds,
      });
    }

    io.to(roomId).emit("userJoined", username);
    roundManager.broadcastParticipants(roomId);

    callback?.({ success: true, roomId, playerId: socket.id });
    console.log(`${username} joined ${roomId}`);

    // Start rotation when there are at least two users
    roundManager.startRotationIfEligible(roomId);
  });

  // Matchmaking: server-generated room IDs and automatic placement
  socket.on("play", ({ name }: { name: string }, callback?: (res: any) => void) => {
    const usernameRaw = String(name ?? "");
    const username = validator.escape(usernameRaw.trim());

    if (!username || username.length < 2 || username.length > 20) {
      return callback?.({ error: "Username must be 2-20 characters" });
    }

    // Try to find a joinable room, otherwise create one
    let roomId = pickRandomJoinableRoomId();
    if (!roomId) {
      roomId = generateRoomId();
      // Ensure room is created
      getRoomState(roomId);
    }

    const state = getRoomState(roomId);
    if (state.users.size >= 8) {
      // Extremely rare race: room filled between selection and join. Retry once with a new room.
      roomId = generateRoomId();
      getRoomState(roomId);
    }

    // Handle reconnect within the same room: replace old socket for same username
    let existingSocketId: string | null = null;
    for (const [sid, user] of state.users.entries()) {
      if (user.username.toLowerCase() === username.toLowerCase()) {
        existingSocketId = sid;
        break;
      }
    }
    if (existingSocketId && existingSocketId !== socket.id) {
      const previousUser = state.users.get(existingSocketId);
      state.users.delete(existingSocketId);
      socketRoom.delete(existingSocketId);
      if (state.currentDrawer === existingSocketId) {
        state.currentDrawer = null;
        io.to(roomId).emit("drawRevoked");
      }
      if (previousUser) {
        io.to(roomId).emit("userLeft", previousUser.username);
      }
      const oldSocket = io.sockets.sockets.get(existingSocketId);
      if (oldSocket) {
        try {
          oldSocket.leave(roomId);
        } catch {}
        oldSocket.disconnect(true);
      }
    }

    // Final capacity guard
    if (state.users.size >= 8) {
      return callback?.({ error: "No available rooms at the moment. Please try again." });
    }

    socket.join(roomId);
    socketRoom.set(socket.id, roomId);
    state.users.set(socket.id, { username, score: 0, isDrawing: false });
    roundManager.onUserJoin(roomId, socket.id);

    if (state.roundInProgress) {
      socket.emit("newRound", {
        roundNumber: state.roundNumber,
        totalRounds: state.totalRounds,
      });
    }

    io.to(roomId).emit("userJoined", username);
    roundManager.broadcastParticipants(roomId);

    callback?.({ success: true, roomId, playerId: socket.id });
    console.log(`${username} joined via matchmaking into ${roomId}`);

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
    checkGuess: (guess) => {
      const room = socketRoom.get(socket.id);
      if (!room) return false;
      const state = getRoomState(room);
      // Drawer cannot guess their own word
      if (state.currentDrawer === socket.id) return false;
      return state.currentWord.length > 0 && guess.toLowerCase() === state.currentWord.toLowerCase();
    },
    onCorrectGuess: (guesserId) => {
      const room = socketRoom.get(socket.id);
      if (!room) return;
      const state = getRoomState(room);

      // Ensure user hasn't already guessed this round
      if (state.correctGuessers.includes(guesserId)) return;

      const timeLeftMs = state.roundEndsAt! - Date.now();
      const timeLeftSeconds = Math.max(0, timeLeftMs / 1000);

      const guesser = state.users.get(guesserId);
      if (guesser) {
        const rank = state.correctGuessers.length;
        const points = calculateGuesserScore(timeLeftSeconds, 80, rank);
        guesser.score += points;
      }

      state.correctGuessers.push(guesserId);
      state.lastGuessTime = Date.now();

      // Update participants with new scores
      roundManager.broadcastParticipants(room);

      // If all players (except the drawer) have guessed, end the turn early.
      const totalPlayers = state.users.size;
      if (state.correctGuessers.length >= totalPlayers - 1) {
        roundManager.rotateToNext(room);
      }
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
        // If not enough players remain, stop; otherwise rotate
        roundManager.ensureSufficientPlayersOrStop(room);
        if (state.roundInProgress) {
          roundManager.rotateToNext(room);
        }
      } else {
        if (state.currentDrawer === socket.id) {
          state.currentDrawer = null;
          for (const [, u] of state.users.entries()) u.isDrawing = false;
          io.to(room).emit("drawRevoked");
        }
        roundManager.broadcastParticipants(room);
        // If insufficient players remain while a round was active, stop the game
        roundManager.ensureSufficientPlayersOrStop(room);
        // Otherwise, if after disconnect we now have >=2 users and no round in progress, start one
        if (!getRoomState(room).roundInProgress) {
          roundManager.startRotationIfEligible(room);
        }
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
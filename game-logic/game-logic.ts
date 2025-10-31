import { Server } from "socket.io";
import { getRandomWords } from "./word-chooser";

type User = { username: string; score: number; isDrawing: boolean };

export type RotationRoomState = {
  currentDrawer: string | null;
  users: Map<string, User>;
  ownerId: string | null;
  drawerOrder: string[];
  currentDrawerIndex: number;
  roundTimer: NodeJS.Timeout | null;
  wordChoiceTimer: NodeJS.Timeout | null;
  hintTimer: NodeJS.Timeout | null;
  roundInProgress: boolean;
  roundEndsAt?: number;
  wordChoiceEndsAt?: number;
  currentWord: string;
  revealedIndices: Set<number>;
  // Include canvas history so we can reset it on drawer transfer
  drawEvents?: any[];
};

export function createRoundManager(
  io: Server,
  getRoomState: (roomId: string) => RotationRoomState
) {
  const ROUND_DURATION_MS = 30000;
  const WORD_CHOICE_DURATION_MS = 15000;

  function broadcastParticipants(roomId: string) {
    const state = getRoomState(roomId);
    io.to(roomId).emit(
      "participants",
      Array.from(state.users.entries()).map(([id, user]) => ({
        socketId: id,
        username: user.username,
        score: user.score,
        isDrawing: user.isDrawing,
      }))
    );
  }

  function grantDrawTo(roomId: string, drawerId: string) {
    const state = getRoomState(roomId);
    // Reset canvas for the new drawer's turn
    if (Array.isArray(state.drawEvents)) {
      state.drawEvents.length = 0;
    }
    io.to(roomId).emit("clear");
    state.currentDrawer = drawerId;
    for (const [id, user] of state.users.entries()) {
      user.isDrawing = id === drawerId;
    }

    // Announce who is choosing a word and for how long
    state.wordChoiceEndsAt = Date.now() + WORD_CHOICE_DURATION_MS;
    io.to(roomId).emit("playerIsChoosingWord", {
      drawerId,
      duration: WORD_CHOICE_DURATION_MS,
    });

    // Send word choices only to the new drawer
    const wordOptions = getRandomWords(3);
    io.to(drawerId).emit("wordChoices", wordOptions);

    broadcastParticipants(roomId);

    // Start a timer for word choice. If it expires, skip their turn.
    clearWordChoiceTimer(state);
    state.wordChoiceTimer = setTimeout(() => {
      const username = state.users.get(drawerId)?.username || "The player";
      io.to(roomId).emit("chatMessage", {
        id: `system_${Date.now()}`,
        author: "System",
        text: `${username} ran out of time to choose a word.`,
        timestamp: Date.now(),
      });
      rotateToNext(roomId);
    }, WORD_CHOICE_DURATION_MS);
  }

  function clearRoundTimer(state: RotationRoomState) {
    if (state.roundTimer) {
      clearTimeout(state.roundTimer);
      state.roundTimer = null;
    }
  }

  function clearWordChoiceTimer(state: RotationRoomState) {
    if (state.wordChoiceTimer) {
      clearTimeout(state.wordChoiceTimer);
      state.wordChoiceTimer = null;
    }
  }

  function clearHintTimer(state: RotationRoomState) {
    if (state.hintTimer) {
      clearTimeout(state.hintTimer);
      state.hintTimer = null;
    }
  }

  function buildDrawerOrder(roomId: string) {
    const state = getRoomState(roomId);
    const allIds = Array.from(state.users.keys());
    const ownerFirst = state.ownerId && allIds.includes(state.ownerId)
      ? [state.ownerId, ...allIds.filter((id) => id !== state.ownerId)]
      : allIds;
    state.drawerOrder = ownerFirst;
    state.currentDrawerIndex = 0;
  }

  function scheduleNextRotation(roomId: string) {
    const state = getRoomState(roomId);
    clearRoundTimer(state);
    state.roundEndsAt = Date.now() + ROUND_DURATION_MS;
    state.roundTimer = setTimeout(() => rotateToNext(roomId), ROUND_DURATION_MS);
  }

  function startRotationIfEligible(roomId: string) {
    const state = getRoomState(roomId);
    if (state.roundInProgress) return;
    if (state.users.size < 2) return;
    buildDrawerOrder(roomId);
    if (state.drawerOrder.length < 2) return;
    state.roundInProgress = true;
    state.currentDrawerIndex = 0;
    grantDrawTo(roomId, state.drawerOrder[state.currentDrawerIndex]);
  }

  function rotateToNext(roomId: string) {
    const state = getRoomState(roomId);
    if (!state.roundInProgress) return;

    // Stop any running timers for the previous player
    clearRoundTimer(state);
    clearWordChoiceTimer(state);
    clearHintTimer(state);

    // Advance to next index
    state.currentDrawerIndex += 1;
    if (state.currentDrawerIndex >= state.drawerOrder.length) {
      // Reached end: end the round (one turn per player)
      state.roundInProgress = false;
      clearRoundTimer(state);
      state.currentDrawer = null;
      for (const [, user] of state.users.entries()) user.isDrawing = false;
      io.to(roomId).emit("drawRevoked");
      broadcastParticipants(roomId);
      return;
    }

    const nextDrawerId = state.drawerOrder[state.currentDrawerIndex];
    grantDrawTo(roomId, nextDrawerId);
  }

  function onUserJoin(roomId: string, socketId: string) {
    const state = getRoomState(roomId);
    if (!state.ownerId) {
      state.ownerId = socketId;
    } else if (state.roundInProgress) {
      if (!state.drawerOrder.includes(socketId)) {
        state.drawerOrder.push(socketId);
      }
    }
  }

  function isCurrentDrawer(roomId: string, socketId: string) {
    const state = getRoomState(roomId);
    return state.currentDrawer === socketId;
  }

  function onUserLeft(roomId: string, socketId: string) {
    const state = getRoomState(roomId);
    const idx = state.drawerOrder.indexOf(socketId);
    if (idx >= 0) {
      // Adjust index so that the next rotation stays consistent
      if (idx <= state.currentDrawerIndex && state.currentDrawerIndex > 0) {
        state.currentDrawerIndex -= 1;
      }
      state.drawerOrder.splice(idx, 1);
    }
    if (state.ownerId === socketId) {
      state.ownerId = null;
    }
  }

  function startMainRoundTimer(roomId: string) {
    const state = getRoomState(roomId);
    // A word has been chosen, clear the choice timer and start the main one
    clearWordChoiceTimer(state);
    scheduleNextRotation(roomId);
    io.to(roomId).emit("roundStart", { duration: ROUND_DURATION_MS });

    // Schedule hints
    state.revealedIndices = new Set();
    scheduleNextHint(roomId, 10000);
  }

  function scheduleNextHint(roomId: string, delay: number) {
    const state = getRoomState(roomId);
    clearHintTimer(state); // Clear previous timer

    if (!state.currentWord || !state.roundInProgress) return;

    state.hintTimer = setTimeout(() => {
      if (!state.currentWord || !state.roundInProgress) return;

      // Find all indices of letters that haven't been revealed yet
      const unrevealedIndices: number[] = [];
      for (let i = 0; i < state.currentWord.length; i++) {
        // Ignore spaces and already revealed letters
        if (state.currentWord[i] !== ' ' && !state.revealedIndices.has(i)) {
          unrevealedIndices.push(i);
        }
      }

      // Only reveal a new letter if there's more than one character left to guess
      if (unrevealedIndices.length > 1) {
        const randomIndexToReveal = unrevealedIndices[Math.floor(Math.random() * unrevealedIndices.length)];
        state.revealedIndices.add(randomIndexToReveal);

        // Reconstruct the hint string with the newly revealed letter
        const newHint = state.currentWord.split('').map((char, index) => {
          if (char === ' ') return ' ';
          return state.revealedIndices.has(index) ? char : '_';
        }).join(' ');

        io.to(roomId).emit("wordHint", newHint.trim());

        // Schedule the next hint
        scheduleNextHint(roomId, 10000);
      }
    }, delay);
  }

  return {
    broadcastParticipants,
    startRotationIfEligible,
    rotateToNext,
    onUserJoin,
    isCurrentDrawer,
    onUserLeft,
    startMainRoundTimer,
  };
}



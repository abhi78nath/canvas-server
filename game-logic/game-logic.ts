import { Server } from "socket.io";

type User = { username: string; score: number; isDrawing: boolean };

export type RotationRoomState = {
  currentDrawer: string | null;
  users: Map<string, User>;
  ownerId: string | null;
  drawerOrder: string[];
  currentDrawerIndex: number;
  roundTimer: NodeJS.Timeout | null;
  roundInProgress: boolean;
  roundEndsAt?: number;
};

export function createRoundManager(
  io: Server,
  getRoomState: (roomId: string) => RotationRoomState
) {
  const ROUND_DURATION_MS = 30000; // default 60s per drawer

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
    state.currentDrawer = drawerId;
    for (const [id, user] of state.users.entries()) {
      user.isDrawing = id === drawerId;
    }
    io.to(roomId).emit("drawGranted", drawerId);
    broadcastParticipants(roomId);
  }

  function clearRoundTimer(state: RotationRoomState) {
    if (state.roundTimer) {
      clearTimeout(state.roundTimer);
      state.roundTimer = null;
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
    scheduleNextRotation(roomId);
  }

  function rotateToNext(roomId: string) {
    const state = getRoomState(roomId);
    if (!state.roundInProgress) return;
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
    scheduleNextRotation(roomId);
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

  return {
    broadcastParticipants,
    startRotationIfEligible,
    rotateToNext,
    onUserJoin,
    isCurrentDrawer,
    onUserLeft,
  };
}



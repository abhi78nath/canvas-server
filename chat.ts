import { Server, Socket } from "socket.io";
import validator from "validator";

export type ChatMessage = {
  id: string;
  author: string;
  text: string;
  timestamp: number;
};

type Deps = {
  getRoomId: () => string | undefined;
  getUsername: () => string | undefined;
  checkGuess: (guess: string) => boolean;
  onCorrectGuess: (guesserId: string) => void;
};

export function registerChatHandlers(io: Server, socket: Socket, deps: Deps) {
  socket.on("chatMessage", (payload: { text: string }) => {
    const roomId = deps.getRoomId();
    if (!roomId) return;

    const rawText = String(payload?.text ?? "");
    const text = validator.trim(validator.escape(rawText)).slice(0, 500);
    if (!text) return;

    const author = deps.getUsername() || "Anonymous";

    // Check for correct guess
    if (deps.checkGuess(text)) {
      deps.onCorrectGuess(socket.id);
      const systemMessage: ChatMessage = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        author: "System",
        text: `${author} guessed the word!`,
        timestamp: Date.now(),
      };
      return io.to(roomId).emit("chatMessage", systemMessage);
    }

    const message: ChatMessage = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      author,
      text,
      timestamp: Date.now(),
    };

    io.to(roomId).emit("chatMessage", message);
  });
}



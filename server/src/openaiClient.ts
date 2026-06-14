// Klient OpenAI — tworzony LENIWIE przy pierwszym użyciu, żeby brak OPENAI_API_KEY
// nie wywalał startu serwera (modele OpenAI są opcjonalne, do porównań).
import OpenAI from "openai";

let client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Brak OPENAI_API_KEY na serwerze — model OpenAI niedostępny.");
  }
  if (!client) client = new OpenAI({ maxRetries: 4 });
  return client;
}

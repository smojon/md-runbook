/** The web's copy of each runbook: localStorage (see docs.ts for the phones). */
const key = (id: string): string => `runbook.text.${id}`;

export async function readDoc(id: string): Promise<string | undefined> {
  return localStorage.getItem(key(id)) ?? undefined;
}

export async function writeDoc(id: string, text: string): Promise<void> {
  localStorage.setItem(key(id), text);
}

export async function deleteDoc(id: string): Promise<void> {
  localStorage.removeItem(key(id));
}

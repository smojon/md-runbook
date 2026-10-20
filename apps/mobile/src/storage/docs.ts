/**
 * The app's own copy of each runbook, kept between launches: a file per runbook in the app's
 * documents folder (runbooks can be up to 2 MB, more than AsyncStorage handles well on Android).
 * The web keeps them in localStorage (docs.web.ts).
 */
import { Directory, File, Paths } from 'expo-file-system';

const dir = (): Directory => new Directory(Paths.document, 'runbooks');
const fileOf = (id: string): File => new File(dir(), `${encodeURIComponent(id)}.md`);

export async function readDoc(id: string): Promise<string | undefined> {
  const f = fileOf(id);
  return f.exists ? f.text() : undefined;
}

export async function writeDoc(id: string, text: string): Promise<void> {
  const d = dir();
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  fileOf(id).write(text);
}

export async function deleteDoc(id: string): Promise<void> {
  const f = fileOf(id);
  if (f.exists) f.delete();
}

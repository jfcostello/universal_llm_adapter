export async function importCliExtension(specifier: string): Promise<any> {
  return import(specifier);
}

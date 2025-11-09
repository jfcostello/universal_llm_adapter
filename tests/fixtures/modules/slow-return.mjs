export async function handle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { result: 'slow' };
}

export default handle;

export async function handler(event) {
  return {
    statusCode: 200,
    body: JSON.stringify({ message: "✅ run-code minimal test working" })
  };
}

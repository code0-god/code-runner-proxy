export async function handler(event) {
  const { language, version, files } = JSON.parse(event.body);

  const res = await fetch('https://onecompiler-apis.p.rapidapi.com/api/v1/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RapidAPI-Key': process.env.ONECOMPILER_API_KEY,
      'X-RapidAPI-Host': 'onecompiler-apis.p.rapidapi.com'
    },
    body: JSON.stringify({ language, version, files })
  });

  const data = await res.json();

  return {
    statusCode: 200,
    body: JSON.stringify(data)
  };
}

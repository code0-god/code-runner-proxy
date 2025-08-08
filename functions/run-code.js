export async function handler(event) {
  try {
    const { language, version, files } = JSON.parse(event.body);

    const apiKey = process.env.ONECOMPILER_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "API key not found" })
      };
    }

    const res = await fetch('https://onecompiler-apis.p.rapidapi.com/api/v1/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'onecompiler-apis.p.rapidapi.com'
      },
      body: JSON.stringify({ language, version, files })
    });

    const data = await res.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
}

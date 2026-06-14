export async function GET(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const res = await fetch(process.env.API_URL!, {
    headers: {
      'X-API-Key': `${process.env.API_KEY}`,
    },
    method: 'POST'
  });

  if (!res.ok) {
    return new Response('Failed to run data fetching', { status: res.status });
  }

  const r = (await res.json()) as { message: string, statusCode: number };

  return new Response(r.message, { status: 200 });
}

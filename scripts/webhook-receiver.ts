import express from 'express';

const port = Number(process.env.PORT ?? 4000);
const app = express();

app.use(express.json({ limit: '1mb' }));

app.post('/webhooks/result-published', (req, res) => {
  const event = {
    receivedAt: new Date().toISOString(),
    path: req.path,
    headers: req.headers,
    body: req.body,
  };
  process.stdout.write(`${JSON.stringify(event)}\n`);
  res.status(204).end();
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(port, () => {
  process.stdout.write(`webhook-receiver listening on http://localhost:${port}\n`);
});


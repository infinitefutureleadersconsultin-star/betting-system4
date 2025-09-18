import cors from 'cors';

const corsMiddleware = cors({
  origin: true,
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
});

export function runCors(req, res) {
  return new Promise((resolve, reject) => {
    corsMiddleware(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      resolve(result);
    });
  });
}

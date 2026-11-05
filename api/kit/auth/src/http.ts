import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

export function mountMethod(
  router: Router,
  method: 'get' | 'post',
  path: string,
  handler: (req: Request, res: Response) => Promise<void>,
): void {
  const bound: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
  router[method](path, bound);
}

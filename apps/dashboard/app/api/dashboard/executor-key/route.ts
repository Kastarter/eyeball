import {
  handleExecutorKeyDelete,
  handleExecutorKeyGet,
  handleExecutorKeyPost,
} from "@/src/lib/executor-key-route";

export function GET(request: Request) {
  return handleExecutorKeyGet(request);
}

export function POST(request: Request) {
  return handleExecutorKeyPost(request);
}

export function DELETE(request: Request) {
  return handleExecutorKeyDelete(request);
}

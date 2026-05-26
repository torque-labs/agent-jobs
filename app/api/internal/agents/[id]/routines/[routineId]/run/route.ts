import { NextResponse } from 'next/server';
import { runRoutine } from '@/lib/routine-runner';

export const runtime = 'nodejs';

/** Run a routine immediately (UI "Run now"). Runs the turn + posts to channel. */
export async function POST(_req: Request, { params }: { params: Promise<{ routineId: string }> }) {
  const { routineId } = await params;
  const result = await runRoutine(routineId);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

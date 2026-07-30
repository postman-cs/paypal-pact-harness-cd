// The serialized-write handler for the git-backed ledger (Decision D12). Recording
// a verification or a deployment is the ONE place concurrent pipelines contend —
// two runs pushing the ledger at once. We resolve it the git-native way: commit,
// push, and on a non-fast-forward rejection, rebase onto the remote and retry.
//
// `exec(cmd, args, opts)` is injected so the retry logic is unit-testable without a
// real remote. It must return stdout (string) on success and THROW on a non-zero
// exit (execFileSync's default). `scripts/ledger-sync.mjs` supplies the real one.

export function commitAndPush({
  exec,
  cwd,
  add = ['.'],
  message,
  branch = 'main',
  remote = 'origin',
  maxAttempts = 5,
}) {
  exec('git', ['add', ...add], { cwd });

  const status = exec('git', ['status', '--porcelain'], { cwd });
  if (typeof status === 'string' && status.trim() === '') {
    return { pushed: false, reason: 'no changes' };
  }

  exec('git', ['commit', '-m', message], { cwd });

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      exec('git', ['push', remote, `HEAD:${branch}`], { cwd });
      return { pushed: true, attempts: attempt };
    } catch (err) {
      lastErr = err;
      // Someone else pushed first — rebase our single commit onto the remote tip
      // and try again. Ledger writes touch distinct files, so rebases apply cleanly.
      exec('git', ['pull', '--rebase', remote, branch], { cwd });
    }
  }
  throw new Error(`ledger push failed after ${maxAttempts} attempt(s): ${lastErr?.message ?? lastErr}`);
}

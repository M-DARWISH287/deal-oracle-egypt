import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, Copy, Check } from 'lucide-react';

const FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/firecrawl-benchmark`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export default function Benchmark() {
  const [loading, setLoading] = useState(false);
  const [output, setOutput] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const run = async () => {
    setLoading(true);
    setError('');
    setOutput('');
    setCopied(false);
    try {
      const res = await fetch(FN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ANON_KEY}`,
          apikey: ANON_KEY,
        },
      });
      const text = await res.text();
      if (!res.ok) {
        setError(`HTTP ${res.status}: ${text}`);
      } else {
        setOutput(text);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="min-h-screen bg-background p-6 md:p-10" dir="ltr">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold">Firecrawl Benchmark</h1>
            <p className="text-sm text-muted-foreground">
              5 queries × 5 stores · 1 request each · 10s hard cap
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={run} disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Running 25 cells…
                </>
              ) : (
                'Run benchmark'
              )}
            </Button>
            <Button
              variant="secondary"
              onClick={copy}
              disabled={!output}
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 mr-2" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 mr-2" /> Copy
                </>
              )}
            </Button>
          </div>
        </header>

        {error && (
          <div className="rounded-md border border-destructive p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <pre className="w-full overflow-auto rounded-md border bg-muted p-4 text-xs leading-relaxed whitespace-pre-wrap break-words min-h-[400px]">
{output || '# Output will appear here.\n# Click "Run benchmark" to start.'}
        </pre>
      </div>
    </div>
  );
}

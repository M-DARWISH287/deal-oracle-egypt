import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { BarChart3, Search, TrendingUp, Activity, Loader2, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface SearchLog {
  id: string;
  query: string;
  results_count: number;
  created_at: string;
}

export default function AdminDashboard() {
  const [logs, setLogs] = useState<SearchLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const handleDownloadReport = async () => {
    setDownloading(true);
    try {
      const url = `https://guynfpxitlwzndninzfo.supabase.co/functions/v1/generate-report`;
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      const objectUrl = URL.createObjectURL(blob);
      a.href = objectUrl;
      a.download = 'benchmark-report-last-10-days.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      toast.success('Report downloaded');
    } catch (e) {
      toast.error(`Failed to generate report: ${String(e)}`);
    } finally {
      setDownloading(false);
    }
  };

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from('search_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) {
        setError(error.message);
      } else {
        setLogs((data ?? []) as SearchLog[]);
      }
      setLoading(false);
    }
    load();
  }, []);

  const totalSearches = logs.length;
  const uniqueQueries = useMemo(() => new Set(logs.map(l => l.query.toLowerCase())).size, [logs]);
  const avgResults = useMemo(
    () => logs.length ? Math.round(logs.reduce((s, l) => s + l.results_count, 0) / logs.length) : 0,
    [logs]
  );

  const topKeywords = useMemo(() => {
    const counts = new Map<string, number>();
    logs.forEach(l => {
      const k = l.query.trim().toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [logs]);

  const maxKeywordCount = topKeywords[0]?.[1] ?? 1;
  const recentLogs = logs.slice(0, 25);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 md:p-10" dir="ltr">
      <div className="max-w-7xl mx-auto space-y-8">
        <header className="space-y-2">
          <div className="flex items-center gap-3">
            <BarChart3 className="h-7 w-7 text-primary" />
            <h1 className="text-3xl font-bold tracking-tight">Admin Dashboard</h1>
          </div>
          <p className="text-muted-foreground">Search analytics &amp; market demand insights</p>
        </header>

        {error && (
          <Card className="border-destructive">
            <CardContent className="pt-6 text-destructive text-sm">Failed to load: {error}</CardContent>
          </Card>
        )}

        {/* Summary metrics */}
        <div className="grid gap-4 md:grid-cols-3">
          <MetricCard icon={<Search className="h-5 w-5" />} label="Total Searches" value={totalSearches} />
          <MetricCard icon={<TrendingUp className="h-5 w-5" />} label="Unique Queries" value={uniqueQueries} />
          <MetricCard icon={<Activity className="h-5 w-5" />} label="Avg Results" value={avgResults} />
        </div>

        {/* Top keywords */}
        <Card>
          <CardHeader>
            <CardTitle>Top Keywords</CardTitle>
            <CardDescription>Most frequently searched queries</CardDescription>
          </CardHeader>
          <CardContent>
            {topKeywords.length === 0 ? (
              <p className="text-sm text-muted-foreground">No searches logged yet.</p>
            ) : (
              <ul className="space-y-3">
                {topKeywords.map(([query, count], i) => (
                  <li key={query} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <span className="text-muted-foreground tabular-nums w-6">#{i + 1}</span>
                        <span className="font-medium">{query}</span>
                      </span>
                      <Badge variant="secondary" className="tabular-nums">{count}</Badge>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${(count / maxKeywordCount) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent activity */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest 25 searches</CardDescription>
          </CardHeader>
          <CardContent>
            {recentLogs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Query</TableHead>
                    <TableHead className="text-right">Results</TableHead>
                    <TableHead className="text-right">Timestamp</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="font-medium">{log.query}</TableCell>
                      <TableCell className="text-right tabular-nums">{log.results_count}</TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums text-xs">
                        {new Date(log.created_at).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MetricCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2">
          <span className="text-primary">{icon}</span>
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold tabular-nums">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

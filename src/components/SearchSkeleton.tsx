export function SearchSkeleton() {
  return (
    <div className="space-y-6">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-2xl bg-card border border-border p-5">
          <div className="flex flex-col sm:flex-row gap-5">
            <div className="skeleton-shimmer w-full sm:w-36 h-36 rounded-xl" />
            <div className="flex-1 space-y-3">
              <div className="skeleton-shimmer h-6 w-3/4 rounded" />
              <div className="skeleton-shimmer h-4 w-1/2 rounded" />
              <div className="skeleton-shimmer h-8 w-40 rounded-full" />
              <div className="space-y-2 mt-4">
                {[0, 1, 2].map((j) => (
                  <div key={j} className="skeleton-shimmer h-12 w-full rounded-xl" />
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

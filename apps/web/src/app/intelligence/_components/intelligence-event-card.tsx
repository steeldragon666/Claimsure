interface EventProps {
  event: {
    id: string;
    raw_title: string;
    raw_content: string;
    source_url: string | null;
    published_at: string;
    classified_at: string | null;
    classification_kind: string | null;
    classification_severity: string | null;
    source_name: string;
  };
}

/**
 * Expanded detail card for a regulatory event row in the /intelligence table.
 */
export function IntelligenceEventCard({ event }: EventProps) {
  return (
    <div className="border-t border-border bg-muted/30 px-6 py-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{event.raw_title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {event.source_name} · Published{' '}
            {new Date(event.published_at).toLocaleDateString('en-AU', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
            {event.classified_at && (
              <>
                {' · Classified '}
                {new Date(event.classified_at).toLocaleDateString('en-AU', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </>
            )}
          </p>
        </div>
        {event.source_url && (
          <a
            href={event.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-xs text-primary underline underline-offset-2"
          >
            View source
          </a>
        )}
      </div>
      <p className="text-sm text-foreground/80 whitespace-pre-wrap leading-relaxed">
        {event.raw_content.length > 1000
          ? event.raw_content.slice(0, 1000) + '...'
          : event.raw_content}
      </p>
    </div>
  );
}

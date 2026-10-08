"use client";

/** Standalone error document: owns its external stylesheet independently of layout CSS. */

export default function GlobalError({
  error,
  retry
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <head>
        <meta name="color-scheme" content="light dark" />
        <link rel="stylesheet" href="/csp-error.css" />
      </head>
      <body>
        <div className="wrap">
          <div className="card" role="alert">
            <h1>XpertApply could not load</h1>
            <p>An unexpected error stopped the application. Your saved data is unaffected.</p>
            <button type="button" onClick={retry}>
              Reload
            </button>
            {error.digest && (
              <p style={{ marginTop: 16, marginBottom: 0 }}>
                Reference: <code>{error.digest}</code>
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}

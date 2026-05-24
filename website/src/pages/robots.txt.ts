const basePath = import.meta.env.BASE_URL.endsWith("/")
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

export function GET({ site }: { site: URL }) {
  const origin = site ?? new URL("https://shipnode.dev");
  const sitemapUrl = new URL(`${basePath}sitemap.xml`, origin);

  return new Response(`User-agent: *
Allow: /

Sitemap: ${sitemapUrl.toString()}
`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

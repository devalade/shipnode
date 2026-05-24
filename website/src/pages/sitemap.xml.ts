const basePath = import.meta.env.BASE_URL.endsWith("/")
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`;

const pages = [
  { path: "", changefreq: "weekly", priority: "1.0" },
  { path: "privacy", changefreq: "yearly", priority: "0.2" },
  { path: "terms", changefreq: "yearly", priority: "0.2" },
];

export function GET({ site }: { site: URL }) {
  const origin = site ?? new URL("https://shipnode.dev");
  const urls = pages
    .map(({ path, changefreq, priority }) => {
      const loc = new URL(`${basePath}${path}`, origin).toString();

      return `  <url>
    <loc>${loc}</loc>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
    })
    .join("\n");

  return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}

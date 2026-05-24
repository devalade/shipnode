import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await getCollection('docs');
  return entries.map((entry) => {
    // entry.id is like "docs/install.md" — strip the leading "docs/" and extension.
    const slug = entry.id.replace(/^docs\//, '').replace(/\.(md|mdx)$/, '');
    return { params: { slug }, props: { entry } };
  });
};

export const GET: APIRoute = ({ props }) => {
  const entry = props.entry as { body: string; data: { title?: string; description?: string } };
  const fm = [
    '---',
    entry.data.title ? `title: ${JSON.stringify(entry.data.title)}` : null,
    entry.data.description ? `description: ${JSON.stringify(entry.data.description)}` : null,
    '---',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  return new Response(`${fm}\n${entry.body ?? ''}`, {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
};

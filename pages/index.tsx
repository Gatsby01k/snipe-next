import dynamic from 'next/dynamic';

const CreatorSnipe = dynamic(() => import('../components/CreatorSnipe'), { ssr: false });

export default function Home() {
  return <CreatorSnipe />;
}

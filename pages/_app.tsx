import type { AppProps } from 'next/app';
import '@solana/wallet-adapter-react-ui/styles.css';
import '../styles/globals.css';

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}

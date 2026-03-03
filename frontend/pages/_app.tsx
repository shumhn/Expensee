import type { AppProps } from 'next/app';
import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import Head from 'next/head';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-wallets';
import '@solana/wallet-adapter-react-ui/styles.css';
import '../styles/globals.css';
import { Outfit, Inter } from 'next/font/google';

const outfit = Outfit({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800', '900'],
  variable: '--font-outfit',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
});

import { ThemeProvider } from '../contexts/ThemeContext';

// Dynamically import WalletModalProvider to avoid SSR issues
const WalletModalProvider = dynamic(
  async () => (await import('@solana/wallet-adapter-react-ui')).WalletModalProvider,
  { ssr: false }
);

export default function App({ Component, pageProps }: AppProps) {
  const network = WalletAdapterNetwork.Devnet;

  // Frontend uses read RPC by default to avoid ER-only RPC read limitations.
  const endpoint = useMemo(
    () =>
      process.env.NEXT_PUBLIC_SOLANA_READ_RPC_URL ||
      process.env.NEXT_PUBLIC_SOLANA_RPC_URL ||
      'https://api.devnet.solana.com',
    []
  );

  const wallets = useMemo(
    () => [
      new SolflareWalletAdapter({ network }),
    ],
    [network]
  );

  return (
    <div className={`${outfit.variable} ${inter.variable}`}>
      <Head>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=2" />
        <link rel="shortcut icon" href="/favicon.svg?v=2" />
      </Head>
      <ConnectionProvider endpoint={endpoint}>
        <WalletProvider wallets={wallets} autoConnect={false} localStorageKey="private-payroll-wallet">
          <ThemeProvider>
            <WalletModalProvider>
              <Component {...pageProps} />
            </WalletModalProvider>
          </ThemeProvider>
        </WalletProvider>
      </ConnectionProvider>
    </div>
  );
}

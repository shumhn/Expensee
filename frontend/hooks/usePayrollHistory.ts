import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import type { ParsedInstruction, PartiallyDecodedInstruction } from '@solana/web3.js';
import {
  INCO_LIGHTNING_ID,
  INCO_TOKEN_PROGRAM_ID,
  MAGICBLOCK_DELEGATION_PROGRAM,
  MAGICBLOCK_MAGIC_PROGRAM,
  MAGICBLOCK_PERMISSION_PROGRAM,
  PAYROLL_PROGRAM_ID,
  PAYUSD_MINT,
} from '../lib/payroll-client';

type Direction = 'in' | 'out' | 'neutral';

export type PayrollHistoryRow = {
  id: string;
  type: string;
  direction: Direction;
  amount: number | null;
  currency: string;
  date: string;
  time: string;
  privacy: 'Private' | 'Standard';
  status: 'Completed' | 'Failed';
  signature: string;
};

export type PayrollHistoryStats = {
  totalIncoming: number | null;
  totalOutgoing: number | null;
  transactionCount: number;
};

const safeToBase58 = (value: any): string | null => {
  if (!value) return null;
  const fn = value.toBase58;
  if (typeof fn !== 'function') return null;
  return fn.call(value);
};

const PROGRAM_IDS = new Set(
  [
    safeToBase58(PAYROLL_PROGRAM_ID),
    safeToBase58(INCO_LIGHTNING_ID),
    safeToBase58(INCO_TOKEN_PROGRAM_ID),
    safeToBase58(MAGICBLOCK_DELEGATION_PROGRAM),
    safeToBase58(MAGICBLOCK_PERMISSION_PROGRAM),
    safeToBase58(MAGICBLOCK_MAGIC_PROGRAM),
  ].filter(Boolean) as string[]
);

const PRIMARY_MINT_KEY = safeToBase58(PAYUSD_MINT) || '';
const INCO_LIGHTNING_KEY = safeToBase58(INCO_LIGHTNING_ID) || '';
const INCO_TOKEN_KEY = safeToBase58(INCO_TOKEN_PROGRAM_ID) || '';

const getProgramId = (inst: ParsedInstruction | PartiallyDecodedInstruction): string | null => {
  const programId = (inst as any).programId;
  if (!programId) return null;
  if (typeof programId === 'string') return programId;
  return programId.toBase58?.() ?? null;
};

const formatDate = (timestamp: number) => {
  const dateObj = new Date(timestamp * 1000);
  return {
    date: dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    time: dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
  };
};

const parseTokenDelta = (
  meta: any,
  owner: string,
  mint: string
): number => {
  if (!meta) return 0;
  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];
  const preMap = new Map<number, number>();
  const postMap = new Map<number, number>();

  for (const balance of pre) {
    if (balance.owner === owner && balance.mint === mint) {
      const amount = Number(balance.uiTokenAmount?.uiAmount ?? balance.uiTokenAmount?.uiAmountString ?? 0);
      preMap.set(balance.accountIndex, amount);
    }
  }

  for (const balance of post) {
    if (balance.owner === owner && balance.mint === mint) {
      const amount = Number(balance.uiTokenAmount?.uiAmount ?? balance.uiTokenAmount?.uiAmountString ?? 0);
      postMap.set(balance.accountIndex, amount);
    }
  }

  const indices = new Set([...preMap.keys(), ...postMap.keys()]);
  let delta = 0;
  indices.forEach((idx) => {
    delta += (postMap.get(idx) ?? 0) - (preMap.get(idx) ?? 0);
  });
  return delta;
};

export function usePayrollHistory(limit = 20) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [rows, setRows] = useState<PayrollHistoryRow[]>([]);
  const [stats, setStats] = useState<PayrollHistoryStats>({
    totalIncoming: null,
    totalOutgoing: null,
    transactionCount: 0,
  });
  const [source, setSource] = useState<'helius' | 'rpc'>('rpc');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || '';
  const heliusKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY || '';
  const cluster = useMemo(() => {
    const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || '';
    return rpcUrl.includes('devnet') ? 'devnet' : 'mainnet-beta';
  }, []);
  const heliusBase = cluster === 'devnet' ? 'https://api-devnet.helius.xyz' : 'https://api.helius.xyz';

  const parseHeliusTx = useCallback(
    (tx: any, walletAddress: string): PayrollHistoryRow | null => {
      const programIds = (tx.instructions || [])
        .map((inst: any) => inst?.programId)
        .filter((id: string | undefined) => !!id);

      const touchesPayroll = programIds.some((id: string) => PROGRAM_IDS.has(id));
      const tokenTransfers = (tx.tokenTransfers || []).filter((t: any) => t.mint === PRIMARY_MINT_KEY);
      const hasPayusd = tokenTransfers.length > 0;

      if (!touchesPayroll && !hasPayusd) return null;

      const { date, time } = formatDate(tx.timestamp);

      let amount: number | null = null;
      let currency = 'USDC';
      let direction: Direction = 'neutral';

      if (hasPayusd) {
        let incoming = 0;
        let outgoing = 0;
        tokenTransfers.forEach((transfer: any) => {
          if (transfer.toUserAccount === walletAddress) incoming += Number(transfer.tokenAmount || 0);
          if (transfer.fromUserAccount === walletAddress) outgoing += Number(transfer.tokenAmount || 0);
        });
        const net = incoming - outgoing;
        amount = Math.abs(net);
        direction = net > 0 ? 'in' : net < 0 ? 'out' : 'neutral';
      }

      const type = programIds.includes(PAYROLL_PROGRAM_ID.toBase58())
        ? 'Payroll'
        : programIds.includes(INCO_TOKEN_PROGRAM_ID.toBase58())
        ? 'Confidential Token'
        : programIds.includes(MAGICBLOCK_DELEGATION_PROGRAM.toBase58())
        ? 'Delegation'
        : 'Program';

      return {
        id: tx.signature,
        type,
        direction,
        amount,
        currency,
        date,
        time,
        privacy: programIds.some(
          (id: string) => (INCO_LIGHTNING_KEY && id === INCO_LIGHTNING_KEY) || (INCO_TOKEN_KEY && id === INCO_TOKEN_KEY)
        )
          ? 'Private'
          : 'Standard',
        status: 'Completed',
        signature: tx.signature,
      };
    },
    []
  );

  const fetchHistory = useCallback(async () => {
    if (!publicKey) {
      setRows([]);
      setStats({ totalIncoming: null, totalOutgoing: null, transactionCount: 0 });
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let payrollRows: PayrollHistoryRow[] = [];

      if (heliusKey) {
        setSource('helius');
        const resp = await fetch(
          `${heliusBase}/v0/addresses/${publicKey.toBase58()}/transactions?api-key=${heliusKey}&limit=${limit}`
        );
        if (!resp.ok) {
          throw new Error(`Helius request failed: ${resp.status}`);
        }
        const data = await resp.json();
        payrollRows = data
          .map((tx: any) => parseHeliusTx(tx, publicKey.toBase58()))
          .filter((row: PayrollHistoryRow | null): row is PayrollHistoryRow => !!row);
      } else {
        setSource('rpc');
        const signatures = await connection.getSignaturesForAddress(publicKey, { limit });
        for (const sigInfo of signatures) {
          const tx = await connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
          });
          if (!tx || !tx.blockTime) continue;

          const instructions = tx.transaction.message.instructions;
          const programIds = instructions
            .map((inst) => getProgramId(inst))
            .filter((id): id is string => !!id);

          const touchesPayroll = programIds.some((id) => PROGRAM_IDS.has(id));
          const tokenDelta = parseTokenDelta(tx.meta, publicKey.toBase58(), PRIMARY_MINT_KEY);
          const hasPayusd = tokenDelta !== 0;

          if (!touchesPayroll && !hasPayusd) continue;

          const { date, time } = formatDate(tx.blockTime);

          let amount: number | null = null;
          let currency = 'USDC';
          let direction: Direction = 'neutral';

          if (hasPayusd) {
            amount = Math.abs(tokenDelta);
            direction = tokenDelta > 0 ? 'in' : 'out';
            currency = 'USDC';
          }

          const type = programIds.includes(PAYROLL_PROGRAM_ID.toBase58())
            ? 'Payroll'
            : programIds.includes(INCO_TOKEN_PROGRAM_ID.toBase58())
            ? 'Confidential Token'
            : programIds.includes(MAGICBLOCK_DELEGATION_PROGRAM.toBase58())
            ? 'Delegation'
            : 'Program';

          payrollRows.push({
            id: sigInfo.signature,
            type,
            direction,
            amount,
            currency,
            date,
            time,
            privacy: programIds.some(
              (id) => (INCO_LIGHTNING_KEY && id === INCO_LIGHTNING_KEY) || (INCO_TOKEN_KEY && id === INCO_TOKEN_KEY)
            )
              ? 'Private'
              : 'Standard',
            status: sigInfo.err ? 'Failed' : 'Completed',
            signature: sigInfo.signature,
          });
        }
      }

      const totals = payrollRows.reduce(
        (acc, row) => {
          if (row.amount === null) return acc;
          if (row.currency !== 'USDC') return acc;
          if (row.direction === 'in') acc.in += row.amount;
          if (row.direction === 'out') acc.out += row.amount;
          return acc;
        },
        { in: 0, out: 0 }
      );

      setRows(payrollRows);
      setStats({
        totalIncoming: payrollRows.some((row) => row.currency === 'USDC' && row.amount !== null) ? totals.in : null,
        totalOutgoing: payrollRows.some((row) => row.currency === 'USDC' && row.amount !== null) ? totals.out : null,
        transactionCount: payrollRows.length,
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to load payroll history');
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey, limit]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return { rows, stats, loading, error, refresh: fetchHistory, cluster, source };
}

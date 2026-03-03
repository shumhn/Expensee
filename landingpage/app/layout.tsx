import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import "./globals.css";
import { ParticleMesh } from "@/components/ParticleMesh";

const instrumentSans = Instrument_Sans({ subsets: ["latin"] });

export const metadata: Metadata = {
    title: "Expensee | Web3 Payroll on Autopilot",
    description: "The gold standard for Web3 payroll and global settlements.",
    icons: {
        icon: "/favicon.svg",
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body className={`${instrumentSans.className} bg-black text-white antialiased overflow-x-hidden`} suppressHydrationWarning>
                <ParticleMesh />
                <div className="relative z-10">
                    {children}
                </div>
            </body>
        </html>
    );
}

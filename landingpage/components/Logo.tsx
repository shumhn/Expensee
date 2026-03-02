"use client";

export function Logo({ className = "w-10 h-10" }: { className?: string }) {
    return (
        <div className={`relative flex items-center justify-center ${className} group`}>
            <svg
                viewBox="0 0 40 40"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="w-full h-full group-hover:rotate-12 transition-transform duration-500"
            >
                {/* Outer circle with gradient */}
                <circle
                    cx="20"
                    cy="20"
                    r="17"
                    stroke="url(#logo-gradient)"
                    strokeWidth="2.5"
                    fill="none"
                />
                <defs>
                    <linearGradient id="logo-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#4F46E5" />
                        <stop offset="100%" stopColor="#06B6D4" />
                    </linearGradient>
                </defs>
                {/* Inner circle */}
                <circle
                    cx="20"
                    cy="20"
                    r="12"
                    stroke="currentColor"
                    className="text-expensee-primary/20"
                    strokeWidth="1.5"
                    fill="currentColor"
                    fillOpacity="0.08"
                />
                {/* Stylized E */}
                <path
                    d="M16 14H25M16 20H23M16 26H25M16 14V26"
                    stroke="currentColor"
                    className="text-expensee-primary"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        </div>
    );
}

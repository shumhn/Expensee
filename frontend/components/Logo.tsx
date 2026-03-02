"use client";

import React from "react";

export function Logo({ className = "w-10 h-10" }: { className?: string }) {
    return (
        <div className={`relative flex items-center justify-center ${className} group`}>
            <svg
                viewBox="0 0 40 40"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="w-full h-full group-hover:rotate-12 transition-transform duration-500"
            >
                {/* Outer circle */}
                <circle
                    cx="20"
                    cy="20"
                    r="17"
                    stroke="currentColor"
                    className="text-expensee-neon"
                    strokeWidth="2.5"
                    fill="none"
                />
                {/* Inner circle */}
                <circle
                    cx="20"
                    cy="20"
                    r="12"
                    stroke="currentColor"
                    className="text-expensee-neon"
                    strokeWidth="1.5"
                    fill="currentColor"
                    fillOpacity="0.08"
                />
                {/* Stylized E */}
                <path
                    d="M16 14H25M16 20H23M16 26H25M16 14V26"
                    stroke="currentColor"
                    className="text-expensee-neon"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        </div>
    );
}

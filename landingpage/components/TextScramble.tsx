"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView } from "framer-motion";

interface TextScrambleProps {
    children: string;
    className?: string;
    trigger?: boolean;
}

const CHARS = "-_~=+*^!#<>";

export function TextScramble({ children, className, trigger = true }: TextScrambleProps) {
    const [displayText, setDisplayText] = useState(children);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const iterationsRef = useRef(0);
    const ref = useRef(null);
    const isInView = useInView(ref, { once: true });

    useEffect(() => {
        if (!isInView || !trigger) return;

        // Reset
        iterationsRef.current = 0;

        intervalRef.current = setInterval(() => {
            setDisplayText((current) =>
                children
                    .split("")
                    .map((char, index) => {
                        if (index < iterationsRef.current) {
                            return children[index];
                        }
                        if (char === " ") return " ";
                        return CHARS[Math.floor(Math.random() * CHARS.length)];
                    })
                    .join("")
            );

            if (iterationsRef.current >= children.length) {
                if (intervalRef.current) clearInterval(intervalRef.current);
            }

            iterationsRef.current += 1 / 3; // Speed control
        }, 30);

        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, [children, isInView, trigger]);

    return <span ref={ref} className={className}>{displayText}</span>;
}

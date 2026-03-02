"use client";

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";

export function Globe() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        let width = canvas.width = 600;
        let height = canvas.height = 600;

        // Globe parameters
        const GLOBE_RADIUS = 240;
        const DOT_RADIUS = 1.5;
        const DOT_COUNT = 800;
        const ROTATION_SPEED = 0.002;

        // Generate points on a sphere (Fibonacci Sphere)
        const points: { x: number; y: number; z: number }[] = [];
        const phi = Math.PI * (3 - Math.sqrt(5)); // Golden angle

        for (let i = 0; i < DOT_COUNT; i++) {
            const y = 1 - (i / (DOT_COUNT - 1)) * 2; // y goes from 1 to -1
            const radius = Math.sqrt(1 - y * y); // radius at y

            const theta = phi * i; // golden angle increment

            const x = Math.cos(theta) * radius;
            const z = Math.sin(theta) * radius;

            points.push({ x: x * GLOBE_RADIUS, y: y * GLOBE_RADIUS, z: z * GLOBE_RADIUS });
        }

        let rotation = 0;

        const render = () => {
            ctx.clearRect(0, 0, width, height);

            // Rotate points
            rotation += ROTATION_SPEED;

            // Sort points by Z depth so simple occlusion works roughly
            const rotatedPoints = points.map(p => {
                // Rotate around Y axis
                const x = p.x * Math.cos(rotation) - p.z * Math.sin(rotation);
                const z = p.x * Math.sin(rotation) + p.z * Math.cos(rotation);
                return { x, y: p.y, z, originalY: p.y };
            }).sort((a, b) => a.z - b.z);

            rotatedPoints.forEach(p => {
                // Perspective projection
                const fov = 1000;
                const scale = fov / (fov - p.z);

                const px = width / 2 + p.x * scale;
                const py = height / 2 + p.y * scale;

                // Fade out dots in back
                const alpha = (p.z + GLOBE_RADIUS) / (2 * GLOBE_RADIUS); // 0 to 1 based on z
                const opacity = Math.max(0.1, Math.min(1, alpha * 0.8));

                // Draw dot
                ctx.beginPath();
                ctx.arc(px, py, DOT_RADIUS * scale, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(30, 186, 152, ${opacity})`; // Kast Teal
                ctx.fill();
            });

            requestAnimationFrame(render);
        };

        const animationId = requestAnimationFrame(render);

        return () => cancelAnimationFrame(animationId);
    }, []);

    return (
        <div className="absolute inset-0 flex items-center justify-center opacity-60">
            <motion.canvas
                ref={canvasRef}
                width={600}
                height={600}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 1.5 }}
                className="w-[600px] h-[600px]"
            />
        </div>
    );
}

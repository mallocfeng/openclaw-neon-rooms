import { Grid, PerspectiveCamera, Sparkles } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";

type FutureSceneProps = {
  connected: boolean;
  streaming: boolean;
};

function Robot({ connected, streaming }: { connected: boolean; streaming: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const eyeRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!groupRef.current) {
      return;
    }

    const t = state.clock.elapsedTime;
    groupRef.current.position.y = -0.18 + Math.sin(t * 1.2) * 0.06;
    groupRef.current.rotation.y = Math.sin(t * 0.5) * 0.18;

    if (eyeRef.current) {
      const material = eyeRef.current.material as THREE.MeshStandardMaterial;
      if (streaming) {
        material.emissiveIntensity = 1.65 + Math.sin(t * 9) * 0.5;
      } else if (connected) {
        material.emissiveIntensity = 0.95 + Math.sin(t * 3.5) * 0.2;
      } else {
        material.emissiveIntensity = 0.2;
      }
    }
  });

  return (
    <group ref={groupRef} position={[0.1, 0, 0]}>
      <mesh castShadow position={[0, 0.8, 0]}>
        <cylinderGeometry args={[0.52, 0.56, 1.2, 28]} />
        <meshStandardMaterial
          color="#71dcff"
          metalness={0.82}
          roughness={0.25}
          emissive="#05374a"
          emissiveIntensity={0.35}
        />
      </mesh>

      <mesh castShadow position={[0, 1.66, 0]}>
        <boxGeometry args={[0.74, 0.52, 0.56]} />
        <meshStandardMaterial
          color="#aef5ff"
          metalness={0.88}
          roughness={0.18}
          emissive="#022535"
          emissiveIntensity={0.72}
        />
      </mesh>

      <mesh ref={eyeRef} position={[0, 1.67, 0.31]}>
        <boxGeometry args={[0.34, 0.1, 0.05]} />
        <meshStandardMaterial color="#9ffef3" emissive="#7efff1" emissiveIntensity={1.15} />
      </mesh>

      <mesh castShadow position={[-0.63, 0.81, 0]}>
        <capsuleGeometry args={[0.11, 0.66, 6, 16]} />
        <meshStandardMaterial color="#64d3f0" metalness={0.8} roughness={0.24} />
      </mesh>
      <mesh castShadow position={[0.63, 0.81, 0]}>
        <capsuleGeometry args={[0.11, 0.66, 6, 16]} />
        <meshStandardMaterial color="#64d3f0" metalness={0.8} roughness={0.24} />
      </mesh>

      <mesh castShadow position={[-0.2, -0.02, 0]}>
        <capsuleGeometry args={[0.12, 0.62, 6, 16]} />
        <meshStandardMaterial color="#5ea9d5" metalness={0.82} roughness={0.24} />
      </mesh>
      <mesh castShadow position={[0.2, -0.02, 0]}>
        <capsuleGeometry args={[0.12, 0.62, 6, 16]} />
        <meshStandardMaterial color="#5ea9d5" metalness={0.82} roughness={0.24} />
      </mesh>

      <mesh castShadow position={[0, 2.04, 0]}>
        <cylinderGeometry args={[0.018, 0.018, 0.24, 12]} />
        <meshStandardMaterial color="#8de9ff" metalness={0.9} roughness={0.18} />
      </mesh>
      <mesh position={[0, 2.2, 0]}>
        <sphereGeometry args={[0.06, 18, 18]} />
        <meshStandardMaterial color="#a5fff4" emissive="#6effed" emissiveIntensity={1.45} />
      </mesh>
    </group>
  );
}

function Scene({ connected, streaming }: FutureSceneProps) {
  return (
    <>
      <color attach="background" args={["#050812"]} />
      <fog attach="fog" args={["#02050b", 8, 28]} />

      <PerspectiveCamera makeDefault position={[0.2, 1.9, 6.2]} fov={40} />

      <hemisphereLight args={["#87ceff", "#02050a", 0.78]} />
      <directionalLight
        castShadow
        position={[4.8, 7.4, 4.2]}
        intensity={1.22}
        color="#8fd8ff"
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <pointLight position={[-1.8, 1.8, 2]} color="#51f1ff" intensity={2.4} distance={7} />
      <pointLight position={[1.8, 1.2, 2.6]} color="#2ed3ff" intensity={1.8} distance={8} />

      <Grid
        position={[0, -0.95, 0]}
        args={[20, 12]}
        cellSize={0.44}
        cellThickness={0.75}
        cellColor="#145175"
        sectionSize={2.4}
        sectionThickness={1.15}
        sectionColor="#35d2ff"
        fadeDistance={30}
        fadeStrength={1.15}
        infiniteGrid
      />

      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.95, 0]}>
        <planeGeometry args={[24, 24]} />
        <meshStandardMaterial color="#050b13" metalness={0.64} roughness={0.58} />
      </mesh>

      <Sparkles
        count={connected ? 70 : 28}
        scale={[5, 3.2, 3.8]}
        position={[0.1, 1.25, 0.2]}
        size={connected ? 2.5 : 1.2}
        speed={streaming ? 0.7 : 0.25}
        color={connected ? "#7ef4ff" : "#688ca2"}
      />

      <Robot connected={connected} streaming={streaming} />
    </>
  );
}

export function FutureScene({ connected, streaming }: FutureSceneProps) {
  return (
    <Canvas dpr={[1, 1.8]} shadows gl={{ antialias: true, alpha: true }}>
      <Scene connected={connected} streaming={streaming} />
    </Canvas>
  );
}

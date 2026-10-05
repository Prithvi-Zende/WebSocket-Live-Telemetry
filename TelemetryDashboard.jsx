import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';

// Target the Hardware Team's IP (configured from IP Handshake)
const SOCKET_SERVER_URL = process.env.REACT_APP_TRANSMITTER_URL || 'http://127.0.0.1:5000';

/**
 * TelemetryDashboard (React.js Component)
 * Implements Section 4 (Example 2) from the Frontend Workflow & Receiver Integration Guide.
 */
const TelemetryDashboard = () => {
  const [sensorData, setSensorData] = useState({
    distance: 0,
    gas: 0,
    touch: 'CLEAR',
    button: 'RELEASED',
  });
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    // 1. Initiate connection on component mount
    const socket = io(SOCKET_SERVER_URL, {
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      setIsConnected(true);
      console.log('Connected to Hardware Transmitter via Socket.IO');
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      console.log('Disconnected from Hardware Transmitter');
    });

    // 2. Listen for broadcasts and update state
    socket.on('sensor_update', (data) => {
      setSensorData(data); // React automatically re-renders the UI
    });

    // 3. Clean up connection on unmount
    return () => socket.disconnect();
  }, []);

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h2 style={styles.title}>Arduino Uno Real-Time Telemetry</h2>
        <span style={isConnected ? styles.badgeOnline : styles.badgeOffline}>
          {isConnected ? '● TRANSMITTER ONLINE' : '○ CONNECTING...'}
        </span>
      </header>

      {/* Primary 4-Sensor Cards from Integration Guide */}
      <div style={styles.dashboard}>
        <div style={styles.card}>
          <div style={styles.cardTitle}>Ultrasonic Sensor</div>
          <div style={styles.cardVal}>{sensorData.distance} cm</div>
          <div style={styles.cardSub}>Distance: {sensorData.distance} cm</div>
        </div>

        <div style={styles.card}>
          <div style={styles.cardTitle}>Gas Sensor (MQ)</div>
          <div style={styles.cardVal}>{sensorData.gas} <small style={styles.unit}>PPM</small></div>
          <div style={styles.cardSub}>Gas Level: {sensorData.gas}</div>
        </div>

        <div style={{
          ...styles.card,
          borderColor: sensorData.touch === 'TOUCHED' ? '#10b981' : 'rgba(255,255,255,0.1)'
        }}>
          <div style={styles.cardTitle}>Touch Sensor</div>
          <div style={{
            ...styles.cardVal,
            color: sensorData.touch === 'TOUCHED' ? '#10b981' : '#94a3b8'
          }}>
            {sensorData.touch}
          </div>
          <div style={styles.cardSub}>Touch: {sensorData.touch}</div>
        </div>

        <div style={{
          ...styles.card,
          borderColor: sensorData.button === 'PRESSED' ? '#f59e0b' : 'rgba(255,255,255,0.1)'
        }}>
          <div style={styles.cardTitle}>Pushbutton</div>
          <div style={{
            ...styles.cardVal,
            color: sensorData.button === 'PRESSED' ? '#f59e0b' : '#94a3b8'
          }}>
            {sensorData.button}
          </div>
          <div style={styles.cardSub}>Button: {sensorData.button}</div>
        </div>
      </div>
    </div>
  );
};

const styles = {
  container: {
    fontFamily: "'Inter', -apple-system, sans-serif",
    padding: '24px',
    backgroundColor: '#070b14',
    color: '#f1f5f9',
    borderRadius: '16px',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    maxWidth: '1000px',
    margin: '20px auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '20px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
    paddingBottom: '12px',
  },
  title: {
    margin: 0,
    fontSize: '1.25rem',
    fontWeight: 700,
    background: 'linear-gradient(135deg, #fff, #00f2fe)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  badgeOnline: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    color: '#10b981',
    border: '1px solid rgba(16, 185, 129, 0.3)',
    borderRadius: '20px',
    padding: '4px 10px',
    fontSize: '0.75rem',
    fontWeight: 600,
  },
  badgeOffline: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    color: '#ef4444',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    borderRadius: '20px',
    padding: '4px 10px',
    fontSize: '0.75rem',
    fontWeight: 600,
  },
  dashboard: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '20px',
  },
  card: {
    backgroundColor: 'rgba(16, 26, 48, 0.65)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '12px',
    padding: '18px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    transition: 'all 0.2s ease',
  },
  cardTitle: {
    fontSize: '0.75rem',
    color: '#94a3b8',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: '8px',
  },
  cardVal: {
    fontSize: '1.8rem',
    fontWeight: 800,
    color: '#ffffff',
    margin: '4px 0',
  },
  unit: {
    fontSize: '0.9rem',
    color: '#64748b',
  },
  cardSub: {
    fontSize: '0.75rem',
    color: '#64748b',
    marginTop: '6px',
    borderTop: '1px solid rgba(255, 255, 255, 0.05)',
    paddingTop: '6px',
  },
};

export default TelemetryDashboard;

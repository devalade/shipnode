export default function Home() {
  const containerStyle: React.CSSProperties = {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  };

  const cardStyle: React.CSSProperties = {
    background: 'rgba(255, 255, 255, 0.95)',
    backdropFilter: 'blur(10px)',
    borderRadius: '24px',
    padding: '3rem',
    maxWidth: '600px',
    width: '90%',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
  };

  const headingStyle: React.CSSProperties = {
    fontSize: '2.5rem',
    fontWeight: '700',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    marginBottom: '1rem',
  };

  const subheadingStyle: React.CSSProperties = {
    fontSize: '1.2rem',
    color: '#4a5568',
    marginBottom: '2rem',
    lineHeight: '1.6',
  };

  const badgeContainerStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.75rem',
    marginBottom: '2rem',
  };

  const badgeStyle: React.CSSProperties = {
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
    padding: '0.5rem 1rem',
    borderRadius: '12px',
    fontSize: '0.9rem',
    fontWeight: '600',
  };

  const featureListStyle: React.CSSProperties = {
    listStyle: 'none',
    padding: 0,
    margin: '1.5rem 0',
  };

  const featureItemStyle: React.CSSProperties = {
    padding: '0.75rem 0',
    fontSize: '1rem',
    color: '#2d3748',
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  };

  const checkmarkStyle: React.CSSProperties = {
    width: '24px',
    height: '24px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'white',
    fontSize: '0.75rem',
    fontWeight: 'bold',
    flexShrink: 0,
  };

  const footerStyle: React.CSSProperties = {
    marginTop: '2rem',
    paddingTop: '1.5rem',
    borderTop: '1px solid #e2e8f0',
    textAlign: 'center',
    color: '#718096',
    fontSize: '0.9rem',
  };

  return (
    <main style={containerStyle}>
      <div style={cardStyle}>
        <h1 style={headingStyle}>ShipNode Deployment</h1>
        <p style={subheadingStyle}>
          Your Next.js application is live and running with zero-downtime deployment
        </p>

        <div style={badgeContainerStyle}>
          <span style={badgeStyle}>Next.js</span>
          <span style={badgeStyle}>Server-Side Rendering</span>
          <span style={badgeStyle}>Production Ready</span>
        </div>

        <ul style={featureListStyle}>
          <li style={featureItemStyle}>
            <span style={checkmarkStyle}>✓</span>
            <span>Zero-downtime deployments with atomic releases</span>
          </li>
          <li style={featureItemStyle}>
            <span style={checkmarkStyle}>✓</span>
            <span>Automatic health checks and rollback</span>
          </li>
          <li style={featureItemStyle}>
            <span style={checkmarkStyle}>✓</span>
            <span>React Server Components enabled</span>
          </li>
          <li style={featureItemStyle}>
            <span style={checkmarkStyle}>✓</span>
            <span>Optimized production build</span>
          </li>
        </ul>

        <div style={footerStyle}>
          Deployed with ❤️ using ShipNode
        </div>
      </div>
    </main>
  );
}

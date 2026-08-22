/**
 * Three.js-based 3D Movement Map for Mindcraft UI
 * Replacement for Plotly 3D scatter plot
 */

class ThreeDMap {
    constructor(containerId) {
        this.containerId = containerId;
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error(`ThreeDMap: Container ${containerId} not found`);
            return;
        }

        this.initialized = false;
        this.width = this.container.clientWidth;
        this.height = this.container.clientHeight;

        this.init();
    }

    init() {
        if (this.initialized) return;

        // Scene setup
        this.scene = new THREE.Scene();
        // Remove background for transparency
        // this.scene.background = new THREE.Color(0x0f1117); 

        // Camera setup - Orthographic for cleaner view
        const frustumSize = 100;
        const aspect = this.width / this.height;
        this.frustumSize = frustumSize;
        this.camera = new THREE.OrthographicCamera(
            frustumSize * aspect / -2,
            frustumSize * aspect / 2,
            frustumSize / 2,
            frustumSize / -2,
            0.1,
            2000
        );
        this.camera.position.set(50, 50, 50);
        this.camera.lookAt(0, 0, 0);
        this.camera.zoom = 1.5;
        this.camera.updateProjectionMatrix();

        // Renderer setup
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(this.width, this.height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0x000000, 0);
        this.container.appendChild(this.renderer.domElement);

        // Controls
        if (typeof THREE.OrbitControls === 'function') {
            this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
            this.controls.enableDamping = true;
            this.controls.dampingFactor = 0.05;
            this.controls.screenSpacePanning = true;
            this.controls.minDistance = 1;
            this.controls.maxDistance = 500;
        }

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        this.scene.add(ambientLight);

        const pointLight = new THREE.PointLight(0xffffff, 0.8);
        pointLight.position.set(100, 100, 100);
        this.scene.add(pointLight);

        // Grid Helper (placed on the XZ plane)
        const gridHelper = new THREE.GridHelper(200, 20, 0x444444, 0x222222);
        this.scene.add(gridHelper);

        // Axis Helper
        const axesHelper = new THREE.AxesHelper(10);
        this.scene.add(axesHelper);

        // Path (Tube) - Will be created when we have data
        this.tubeMaterial = new THREE.MeshPhongMaterial({
            color: 0x10b981,
            emissive: 0x10b981,
            emissiveIntensity: 0.8,
            transparent: true,
            opacity: 0.8,
            side: THREE.DoubleSide
        });
        this.trail = null; // Will be created when we have points
        this.tubeGeometry = null;

        // Current Position Marker
        const markerGeometry = new THREE.SphereGeometry(1.0, 16, 16);
        const markerMaterial = new THREE.MeshPhongMaterial({ 
            color: 0x10b981, 
            emissive: 0x10b981,
            emissiveIntensity: 1.0,
            transparent: true,
            opacity: 0.9
        });
        this.marker = new THREE.Mesh(markerGeometry, markerMaterial);
        this.scene.add(this.marker);

        // Handle window resize
        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.container);

        // Initialize overlay
        this.overlay = document.createElement('div');
        this.overlay.style.position = 'absolute';
        this.overlay.style.top = '10px';
        this.overlay.style.left = '10px';
        this.overlay.style.padding = '8px 12px';
        this.overlay.style.background = 'rgba(0, 0, 0, 0.6)';
        this.overlay.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        this.overlay.style.borderRadius = '6px';
        this.overlay.style.fontFamily = 'monospace';
        this.overlay.style.fontSize = '12px';
        this.overlay.style.color = '#e0e0e0';
        this.overlay.style.pointerEvents = 'none';
        this.overlay.style.backdropFilter = 'blur(4px)';
        this.overlay.innerHTML = 'Waiting for data...';
        this.container.appendChild(this.overlay);

        this.initialized = true;
        this.hasCentered = false; // Track if we've centered on the agent
        this.animate();
    }

    onResize() {
        if (!this.container) return;
        this.width = this.container.clientWidth;
        this.height = this.container.clientHeight;

        if (this.camera) {
            const aspect = this.width / this.height;
            this.camera.left = this.frustumSize * aspect / -2;
            this.camera.right = this.frustumSize * aspect / 2;
            this.camera.top = this.frustumSize / 2;
            this.camera.bottom = this.frustumSize / -2;
            this.camera.updateProjectionMatrix();
        }

        if (this.renderer) {
            this.renderer.setSize(this.width, this.height);
        }
    }

    animate() {
        if (!this.initialized) return;
        this.animationId = requestAnimationFrame(() => this.animate());

        if (this.controls) {
            this.controls.update();
        }

        this.renderer.render(this.scene, this.camera);
    }

    update(positions) {
        if (!this.initialized || !positions || positions.length === 0) return;

        // Anchor is the CURRENT (most recent) position, so the scene origin
        // — and therefore the axes/grid — always represents "here". The
        // trail is drawn behind it in relative coordinates.
        const points = [];
        const currentPos = positions[positions.length - 1];
        const origin = new THREE.Vector3(currentPos.x, currentPos.y, currentPos.z);

        positions.forEach(p => {
            if (p) {
                const vec = new THREE.Vector3(p.x - origin.x, p.y - origin.y, p.z - origin.z);

                // Debounce/Filter very close points to avoid tube artifacts
                if (points.length > 0) {
                    const last = points[points.length - 1];
                    if (last.distanceTo(vec) < 0.1) return;
                }

                points.push(vec);
            }
        });

        if (points.length > 1) {
            // Update Curve and Tube
            if (this.tubeGeometry) this.tubeGeometry.dispose();

            this.curve = new THREE.CatmullRomCurve3(points);
            this.tubeGeometry = new THREE.TubeGeometry(this.curve, Math.max(2, points.length * 2), 0.3, 6, false);

            // Create trail mesh if it doesn't exist
            if (!this.trail) {
                this.trail = new THREE.Mesh(this.tubeGeometry, this.tubeMaterial);
                this.scene.add(this.trail);
            } else {
                this.trail.geometry = this.tubeGeometry;
            }
        }

        // Current position is always the anchor, so the marker sits at the
        // scene origin — coincident with the axes helper — regardless of
        // where the agent actually is in the world.
        this.marker.position.set(0, 0, 0);

        // Overlay still reports the true world coordinates of "here"
        this.overlay.innerHTML = `
            <div style="margin-bottom: 4px; font-weight: bold; color: #fff;">POSITION</div>
            <div><span style="color: #ff5252">X:</span> ${currentPos.x.toFixed(1)}</div>
            <div><span style="color: #69f0ae">Y:</span> ${currentPos.y.toFixed(1)}</div>
            <div><span style="color: #448aff">Z:</span> ${currentPos.z.toFixed(1)}</div>
        `;

        // "Here" is always (0,0,0) now, so the camera only needs to be
        // aimed at the origin once — it never has to re-center again.
        if (!this.hasCentered && this.controls) {
            this.controls.target.set(0, 0, 0);
            this.camera.position.set(60, 60, 60);
            this.camera.zoom = 2;
            this.camera.updateProjectionMatrix();
            this.controls.update();
            this.hasCentered = true;
        }
    }

    dispose() {
        this.initialized = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        if (this.overlay && this.container.contains(this.overlay)) {
            this.container.removeChild(this.overlay);
        }
        if (this.renderer) {
            if (this.container && this.container.contains(this.renderer.domElement)) {
                this.container.removeChild(this.renderer.domElement);
            }
            this.renderer.dispose();
            this.renderer.forceContextLoss(); // Force context loss to free resources
        }
        if (this.tubeGeometry) this.tubeGeometry.dispose();
        if (this.tubeMaterial) this.tubeMaterial.dispose();
        if (this.trail) {
            if (this.scene) this.scene.remove(this.trail);
            if (this.trail.geometry) this.trail.geometry.dispose();
        }
        if (this.marker) {
            if (this.scene) this.scene.remove(this.marker);
            this.marker.geometry.dispose();
            this.marker.material.dispose();
        }
    }
}

// Global registry for maps
window.threeMaps = new Map();

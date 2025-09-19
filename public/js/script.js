// Wait for DOM to be fully loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚌 Bus Tracking System Initialized');
  
  // Initialize Socket.IO connection
  const socket = io();
  
  // Custom map icons
  const userIcon = L.icon({
    iconUrl: '/pin.png',
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -32]
  });
  
  const busIcon = L.icon({
    iconUrl: '/bus.png',
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -32]
  });
  
  const stopIcon = L.icon({
    iconUrl: 'data:image/svg+xml;base64,' + btoa(`
      <svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
        <circle cx="10" cy="10" r="8" fill="#4CAF50" stroke="white" stroke-width="2"/>
        <circle cx="10" cy="10" r="4" fill="white"/>
      </svg>
    `),
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });

  // Initialize Leaflet map
  const map = L.map('map').setView([18.5204, 73.8567], 13);
  
  // Add OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);

  // Map markers and layers
  let userMarker = null;
  let busMarkers = new Map(); // Map of bus ID -> marker
  let routeLayers = new Map(); // Map of route ID -> layer group
  let stopMarkers = new Map(); // Map of stop markers
  
  // User state
  let currentUserRole = 'user';
  let currentLocation = null;
  let selectedBusId = null;
  let availableRoutes = {};
  let watchId = null;
  let isInitialized = false;

  // DOM elements
  const statusElement = document.getElementById('status');
  const distanceElement = document.getElementById('distance');
  const etaElement = document.getElementById('eta');
  const routeInfoElement = document.getElementById('route-info');
  const becomeBusBtn = document.getElementById('become-bus');
  const becomeUserBtn = document.getElementById('become-user');
  const busNumberInput = document.getElementById('bus-number');
  const routeSelect = document.getElementById('route-select');
  const busListElement = document.getElementById('bus-list');
  const loadingOverlay = document.getElementById('loading-overlay');
  const errorToast = document.getElementById('error-toast');

  // Utility Functions
  function updateStatus(message, isError = false) {
    if (!statusElement) return;
    statusElement.innerHTML = message;
    statusElement.className = isError ? 'status error' : 'status';
    console.log(isError ? '❌' : '✅', message.replace(/<[^>]*>/g, ''));
  }

  function showError(message) {
    if (!errorToast) return;
    const messageElement = errorToast.querySelector('.error-message');
    if (messageElement) {
      messageElement.textContent = message;
      errorToast.classList.add('show');
      
      // Auto hide after 5 seconds
      setTimeout(() => {
        errorToast.classList.remove('show');
      }, 5000);
    }
    console.error('❌', message);
  }

  function hideLoading() {
    if (loadingOverlay) {
      loadingOverlay.style.display = 'none';
    }
  }

  function formatDistance(km) {
    const numKm = parseFloat(km);
    if (isNaN(numKm)) return '--';
    if (numKm < 1) {
      return `${Math.round(numKm * 1000)}m`;
    }
    return `${numKm.toFixed(1)}km`;
  }

  function createRoutePolyline(route, routeId) {
    if (!route || !route.stops || route.stops.length < 2) return null;
    
    const coordinates = route.stops.map(stop => [stop.lat, stop.lon]);
    const polyline = L.polyline(coordinates, {
      color: route.color || '#007cba',
      weight: 4,
      opacity: 0.8
    });
    
    return polyline;
  }

  function addRouteStops(route, routeId) {
    if (!route || !route.stops) return L.layerGroup();
    
    const layerGroup = L.layerGroup();
    
    route.stops.forEach((stop, index) => {
      const marker = L.marker([stop.lat, stop.lon], { icon: stopIcon })
        .bindPopup(`
          <div class="stop-popup">
            <h4>${stop.name}</h4>
            <p><strong>Route:</strong> ${route.name}</p>
            <p><strong>Stop ${index + 1}</strong></p>
            <div class="schedule">
              <strong>Schedule:</strong><br>
              ${stop.schedule ? stop.schedule.join(', ') : 'No schedule available'}
            </div>
          </div>
        `);
      layerGroup.addLayer(marker);
    });
    
    return layerGroup;
  }

  function displayRouteOnMap(routeId) {
    try {
      // Clear existing route layers
      routeLayers.forEach(layer => {
        if (map.hasLayer(layer)) {
          map.removeLayer(layer);
        }
      });
      routeLayers.clear();
      
      const route = availableRoutes[routeId];
      if (!route) return;
      
      // Add route polyline
      const polyline = createRoutePolyline(route, routeId);
      if (polyline) {
        polyline.addTo(map);
        
        // Add stops
        const stopsLayer = addRouteStops(route, routeId);
        stopsLayer.addTo(map);
        
        // Store layers for later removal
        const combinedLayer = L.layerGroup([polyline, stopsLayer]);
        routeLayers.set(routeId, combinedLayer);
        
        // Fit map to route bounds
        const bounds = L.latLngBounds(route.stops.map(stop => [stop.lat, stop.lon]));
        map.fitBounds(bounds, { padding: [20, 20] });
      }
    } catch (error) {
      console.error('Error displaying route on map:', error);
      showError('Failed to display route on map');
    }
  }

  function updateBusList(buses) {
    if (!busListElement) return;
    
    if (currentUserRole === 'bus') {
      busListElement.style.display = 'none';
      return;
    }
    
    busListElement.style.display = 'block';
    busListElement.innerHTML = '<h4>🚌 Nearby Buses</h4>';
    
    if (!buses || buses.length === 0) {
      busListElement.innerHTML += '<p class="no-buses">No buses nearby</p>';
      return;
    }
    
    // Sort buses by distance
    const sortedBuses = buses.sort((a, b) => 
      parseFloat(a.eta.distance) - parseFloat(b.eta.distance)
    );
    
    sortedBuses.forEach(bus => {
      const busItem = document.createElement('div');
      busItem.className = 'bus-item';
      busItem.innerHTML = `
        <div class="bus-header">
          <span class="bus-number">Bus #${bus.busNumber}</span>
          <span class="bus-route">${bus.route ? bus.route.name : 'Unknown Route'}</span>
        </div>
        <div class="bus-info">
          <span class="distance">${formatDistance(bus.eta.distance)}</span>
          <span class="eta">ETA: ${bus.eta.etaText}</span>
        </div>
        <div class="next-stop">
          ${bus.nearestStop ? `Next: ${bus.nearestStop.name}` : 'In transit'}
        </div>
      `;
      
      busItem.addEventListener('click', () => {
        selectBus(bus);
      });
      
      busListElement.appendChild(busItem);
    });
  }

  function selectBus(bus) {
    try {
      selectedBusId = bus.id;
      
      // Highlight selected bus
      document.querySelectorAll('.bus-item').forEach(item => {
        item.classList.remove('selected');
      });
      event.currentTarget.classList.add('selected');
      
      // Show route for selected bus
      displayRouteOnMap(bus.routeId);
      
      // Update info panel
      if (routeInfoElement) {
        routeInfoElement.innerHTML = `
          <h4>Selected Bus #${bus.busNumber}</h4>
          <p><strong>Route:</strong> ${bus.route ? bus.route.name : 'Unknown'}</p>
          <p><strong>Distance:</strong> ${formatDistance(bus.eta.distance)}</p>
          <p><strong>ETA:</strong> ${bus.eta.etaText}</p>
          ${bus.nearestStop ? `<p><strong>Next Stop:</strong> ${bus.nearestStop.name}</p>` : ''}
        `;
      }
    } catch (error) {
      console.error('Error selecting bus:', error);
      showError('Failed to select bus');
    }
  }

  // Geolocation handling
  function startLocationTracking() {
    if (!navigator.geolocation) {
      showError('Geolocation is not supported by this browser');
      hideLoading();
      return;
    }

    // Get initial position
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        currentLocation = { lat: latitude, lon: longitude };
        
        // Create initial user marker for users
        if (currentUserRole === 'user') {
          userMarker = L.marker([latitude, longitude], { icon: userIcon })
            .addTo(map)
            .bindPopup('📍 Your Location');
          map.setView([latitude, longitude], 15);
        }
        
        // Start watching position
        watchId = navigator.geolocation.watchPosition(
          (position) => {
            const { latitude, longitude } = position.coords;
            currentLocation = { lat: latitude, lon: longitude };
            
            // Update user marker for users only
            if (currentUserRole === 'user' && userMarker) {
              userMarker.setLatLng([latitude, longitude]);
            }
            
            // Send location update to server
            socket.emit('location-update', {
              lat: latitude,
              lon: longitude
            });
          },
          (error) => {
            console.error('Geolocation error:', error);
            let errorMessage = 'Location error: ';
            switch(error.code) {
              case error.PERMISSION_DENIED:
                errorMessage += 'Permission denied';
                break;
              case error.POSITION_UNAVAILABLE:
                errorMessage += 'Position unavailable';
                break;
              case error.TIMEOUT:
                errorMessage += 'Request timeout';
                break;
              default:
                errorMessage += 'Unknown error';
            }
            showError(errorMessage);
          },
          {
            enableHighAccuracy: true,
            maximumAge: 10000,
            timeout: 15000
          }
        );
        
        hideLoading();
        isInitialized = true;
      },
      (error) => {
        console.error('Initial geolocation error:', error);
        showError('Failed to get your location. Please enable GPS.');
        hideLoading();
      },
      {
        enableHighAccuracy: true,
        timeout: 10000
      }
    );
  }

  // Socket event handlers
  socket.on('connect', () => {
    console.log('✅ Connected to server');
    updateStatus('Connected - Getting your location...');
  });

  socket.on('disconnect', () => {
    console.log('❌ Disconnected from server');
    updateStatus('Disconnected from server', true);
    showError('Connection lost. Trying to reconnect...');
  });

  socket.on('reconnect', () => {
    console.log('🔄 Reconnected to server');
    updateStatus('Reconnected to server');
  });

  socket.on('initial-data', (data) => {
    try {
      console.log('📦 Received initial data:', data);
      availableRoutes = data.routes || {};
      
      // Populate route select dropdown
      if (routeSelect) {
        // Clear existing options except the first one
        routeSelect.innerHTML = '<option value="">Choose a route...</option>';
        
        Object.keys(availableRoutes).forEach(routeId => {
          const option = document.createElement('option');
          option.value = routeId;
          option.textContent = availableRoutes[routeId].name;
          routeSelect.appendChild(option);
        });
      }
      
      updateStatus('You are a <strong>user</strong>');
      
      // Start location tracking after receiving initial data
      if (!isInitialized) {
        startLocationTracking();
      }
    } catch (error) {
      console.error('Error processing initial data:', error);
      showError('Failed to initialize application');
      hideLoading();
    }
  });

  socket.on('nearby-buses-update', (buses) => {
    try {
      console.log('🚌 Nearby buses update:', buses);
      updateBusList(buses);
      
      // Update distance and ETA display for closest bus
      if (distanceElement && etaElement) {
        if (buses && buses.length > 0) {
          const nearest = buses[0]; // Already sorted by distance
          distanceElement.textContent = `Distance: ${formatDistance(nearest.eta.distance)}`;
          etaElement.textContent = `ETA: ${nearest.eta.etaText}`;
        } else {
          distanceElement.textContent = 'Distance: --';
          etaElement.textContent = 'ETA: --';
        }
      }
    } catch (error) {
      console.error('Error updating nearby buses:', error);
      showError('Failed to update bus information');
    }
  });

  socket.on('bus-location-update', (busData) => {
    try {
      console.log('📍 Bus location update:', busData);
      
      if (!busData || !busData.location) return;
      
      // Update or create bus marker on map
      if (busMarkers.has(busData.id)) {
        const marker = busMarkers.get(busData.id);
        marker.setLatLng([busData.location.lat, busData.location.lon]);
        
        // Update popup content
        const routeName = availableRoutes[busData.routeId]?.name || 'Unknown Route';
        marker.setPopupContent(`
          <div class="bus-popup">
            <h4>🚌 Bus #${busData.busNumber}</h4>
            <p>${routeName}</p>
            ${busData.nearestStop ? `<p>Next: ${busData.nearestStop.name}</p>` : '<p>In transit</p>'}
          </div>
        `);
      } else {
        const routeName = availableRoutes[busData.routeId]?.name || 'Unknown Route';
        const marker = L.marker([busData.location.lat, busData.location.lon], { icon: busIcon })
          .addTo(map)
          .bindPopup(`
            <div class="bus-popup">
              <h4>🚌 Bus #${busData.busNumber}</h4>
              <p>${routeName}</p>
              ${busData.nearestStop ? `<p>Next: ${busData.nearestStop.name}</p>` : '<p>In transit</p>'}
            </div>
          `);
        busMarkers.set(busData.id, marker);
      }
    } catch (error) {
      console.error('Error updating bus location:', error);
    }
  });

  socket.on('new-bus-active', (busData) => {
    console.log('🆕 New bus active:', busData);
    // Bus will be handled by bus-location-update event
  });

  socket.on('bus-inactive', (data) => {
    try {
      console.log('⚠️ Bus inactive:', data);
      
      // Remove bus marker from map
      if (busMarkers.has(data.busId)) {
        const marker = busMarkers.get(data.busId);
        if (map.hasLayer(marker)) {
          map.removeLayer(marker);
        }
        busMarkers.delete(data.busId);
      }
      
      // Clear selection if this was the selected bus
      if (selectedBusId === data.busId) {
        selectedBusId = null;
        if (routeInfoElement) {
          routeInfoElement.innerHTML = '';
        }
        // Clear route display
        routeLayers.forEach(layer => {
          if (map.hasLayer(layer)) {
            map.removeLayer(layer);
          }
        });
        routeLayers.clear();
      }
    } catch (error) {
      console.error('Error handling bus inactive:', error);
    }
  });

  socket.on('role-changed', (data) => {
    try {
      currentUserRole = data.role;
      
      if (data.role === 'bus') {
        updateStatus(`You are <strong>Bus #${data.busNumber}</strong> on ${data.route.name}`);
        
        // Hide user marker when becoming a bus
        if (userMarker && map.hasLayer(userMarker)) {
          map.removeLayer(userMarker);
          userMarker = null;
        }
        
        // Show route for this bus
        displayRouteOnMap(data.routeId);
        
        // Hide bus list
        if (busListElement) {
          busListElement.style.display = 'none';
        }
        
        // Update route info panel
        if (routeInfoElement) {
          routeInfoElement.innerHTML = `
            <h4>🚌 Your Route: ${data.route.name}</h4>
            <p><strong>Total Stops:</strong> ${data.route.stops.length}</p>
            <div class="route-stops">
              <strong>Route Stops:</strong>
              ${data.route.stops.map((stop, index) => 
                `<div class="stop-item">${index + 1}. ${stop.name}</div>`
              ).join('')}
            </div>
          `;
        }
        
        // Clear distance/ETA display as buses don't need this info
        if (distanceElement) distanceElement.textContent = 'Distance: --';
        if (etaElement) etaElement.textContent = 'ETA: --';
        
      } else {
        updateStatus('You are a <strong>user</strong>');
        
        // Clear route display
        routeLayers.forEach(layer => {
          if (map.hasLayer(layer)) {
            map.removeLayer(layer);
          }
        });
        routeLayers.clear();
        
        // Show bus list
        if (busListElement) {
          busListElement.style.display = 'block';
        }
        
        // Clear route info
        if (routeInfoElement) {
          routeInfoElement.innerHTML = '';
        }
        
        // Recreate user location marker if we have current location
        if (currentLocation) {
          userMarker = L.marker([currentLocation.lat, currentLocation.lon], { icon: userIcon })
            .addTo(map)
            .bindPopup('📍 Your Location');
          map.setView([currentLocation.lat, currentLocation.lon], 15);
        }
      }
    } catch (error) {
      console.error('Error handling role change:', error);
      showError('Failed to change role');
    }
  });

  socket.on('error', (data) => {
    console.error('❌ Server error:', data.message);
    showError(data.message);
  });

  // Button event handlers
  if (becomeBusBtn) {
    becomeBusBtn.addEventListener('click', () => {
      try {
        const busNumber = busNumberInput?.value.trim();
        const routeId = routeSelect?.value;
        
        if (!busNumber) {
          showError('Please enter a bus number');
          return;
        }
        
        if (!routeId) {
          showError('Please select a route');
          return;
        }
        
        // Validate bus number format (alphanumeric, 1-10 characters)
        if (!/^[a-zA-Z0-9]{1,10}$/.test(busNumber)) {
          showError('Bus number must be 1-10 alphanumeric characters');
          return;
        }
        
        socket.emit('become-bus', {
          busNumber: busNumber,
          routeId: routeId
        });
        
      } catch (error) {
        console.error('Error becoming bus:', error);
        showError('Failed to become bus');
      }
    });
  }

  if (becomeUserBtn) {
    becomeUserBtn.addEventListener('click', () => {
      try {
        socket.emit('become-user');
        
        // Clear form
        if (busNumberInput) busNumberInput.value = '';
        if (routeSelect) routeSelect.value = '';
        
      } catch (error) {
        console.error('Error becoming user:', error);
        showError('Failed to become user');
      }
    });
  }

  // Close error toast handler
  const closeToastBtn = document.querySelector('.close-toast');
  if (closeToastBtn && errorToast) {
    closeToastBtn.addEventListener('click', () => {
      errorToast.classList.remove('show');
    });
  }

  // Handle page visibility change to pause/resume location tracking
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      console.log('🔇 Page hidden - reducing update frequency');
    } else {
      console.log('🔊 Page visible - resuming normal updates');
      // Emit current location when page becomes visible again
      if (currentLocation) {
        socket.emit('location-update', currentLocation);
      }
    }
  });

  // Handle window beforeunload to cleanup
  window.addEventListener('beforeunload', () => {
    if (watchId) {
      navigator.geolocation.clearWatch(watchId);
    }
  });

  // Handle connection errors
  socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    showError('Failed to connect to server. Please check your internet connection.');
  });

  // Initialize error toast auto-hide
  if (errorToast) {
    errorToast.addEventListener('click', () => {
      errorToast.classList.remove('show');
    });
  }

  // Log successful initialization
  console.log('🎯 Bus Tracking System Ready!');
  console.log('📡 Socket ID:', socket.id);
  console.log('🌍 Waiting for GPS location...');
});
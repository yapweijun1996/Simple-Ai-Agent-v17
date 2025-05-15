/**
 * ./js/settings-controller.js
 * Settings Controller Module - Manages application settings
 * Handles settings modal and persistence of user preferences
 */
const SettingsController = (function() {
    'use strict';

    // Private state
    let settingsModal = null;
    let settings = {
        streaming: false, // Default: unchecked
        enableCoT: true,  // Default: checked
        showThinking: true,
        selectedModel: 'gemini-2.0-flash', // Default model changed to Gemini 2.0 Flash
        darkMode: true, // Default dark mode is now true
        debug: true // Debug logging ON by default
    };

    /**
     * Creates and attaches the settings modal
     */
    function createSettingsModal() {
        if (settingsModal) return;
        
        // Create modal from template
        settingsModal = Utils.createFromTemplate('settings-modal-template');
        document.body.appendChild(settingsModal);
        
        // Set initial values based on current settings
        document.getElementById('streaming-toggle').checked = settings.streaming;
        document.getElementById('cot-toggle').checked = settings.enableCoT;
        document.getElementById('show-thinking-toggle').checked = settings.showThinking;
        document.getElementById('model-select').value = settings.selectedModel;
        document.getElementById('dark-mode-toggle').checked = settings.darkMode;
        document.getElementById('debug-toggle').checked = settings.debug;
        
        // Add event listeners
        document.getElementById('save-settings').addEventListener('click', saveSettings);
        document.getElementById('close-settings').addEventListener('click', hideSettingsModal);
        
        // Close when clicking outside the modal content
        settingsModal.addEventListener('click', function(event) {
            if (event.target === settingsModal) {
                hideSettingsModal();
            }
        });

        // Focus trap logic
        const modalContent = settingsModal.querySelector('.settings-modal__content');
        const focusableSelectors = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
        let focusableEls = Array.from(modalContent.querySelectorAll(focusableSelectors));
        let firstEl = focusableEls[0];
        let lastEl = focusableEls[focusableEls.length - 1];
        settingsModal.addEventListener('keydown', function(e) {
            if (e.key === 'Tab') {
                focusableEls = Array.from(modalContent.querySelectorAll(focusableSelectors));
                firstEl = focusableEls[0];
                lastEl = focusableEls[focusableEls.length - 1];
                if (e.shiftKey) {
                    if (document.activeElement === firstEl) {
                        e.preventDefault();
                        lastEl.focus();
                    }
                } else {
                    if (document.activeElement === lastEl) {
                        e.preventDefault();
                        firstEl.focus();
                    }
                }
            } else if (e.key === 'Escape') {
                hideSettingsModal();
            }
        });
    }

    /**
     * Shows the settings modal
     */
    function showSettingsModal() {
        if (!settingsModal) {
            createSettingsModal();
        }
        
        // Ensure current settings are reflected when opening
        settingsModal.style.display = 'flex';
        document.getElementById('streaming-toggle').checked = settings.streaming;
        document.getElementById('cot-toggle').checked = settings.enableCoT;
        document.getElementById('show-thinking-toggle').checked = settings.showThinking;
        document.getElementById('model-select').value = settings.selectedModel;
        document.getElementById('dark-mode-toggle').checked = settings.darkMode;
        document.getElementById('debug-toggle').checked = settings.debug;
        // Focus first element
        setTimeout(() => {
            const modalContent = settingsModal.querySelector('.settings-modal__content');
            const focusable = modalContent.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
            if (focusable.length) focusable[0].focus();
        }, 0);
        // Save last focused element
        showSettingsModal.lastFocused = document.activeElement;
    }

    /**
     * Hides the settings modal
     */
    function hideSettingsModal() {
        if (settingsModal) {
            settingsModal.style.display = 'none';
            // Restore focus to settings button
            if (showSettingsModal.lastFocused) {
                showSettingsModal.lastFocused.focus();
            }
        }
    }

    /**
     * Saves settings from the modal
     */
    function saveSettings() {
        const streamingEnabled = document.getElementById('streaming-toggle').checked;
        const cotEnabled = document.getElementById('cot-toggle').checked;
        const showThinkingEnabled = document.getElementById('show-thinking-toggle').checked;
        const selectedModelValue = document.getElementById('model-select').value;
        const darkModeEnabled = document.getElementById('dark-mode-toggle').checked;
        const debugEnabled = document.getElementById('debug-toggle').checked;
        
        settings = {
            ...settings,
            streaming: streamingEnabled,
            enableCoT: cotEnabled,
            showThinking: showThinkingEnabled,
            selectedModel: selectedModelValue,
            darkMode: darkModeEnabled,
            debug: debugEnabled
        };
        
        // Update light/dark mode class
        if (darkModeEnabled) {
            document.body.classList.remove('light-mode');
        } else {
            document.body.classList.add('light-mode');
        }
        
        // Update the chat controller settings
        ChatController.updateSettings(settings);
        
        // Save settings to cookie
        Utils.saveSettingsToCookie(settings);
        
        // Hide modal
        hideSettingsModal();
    }

    /**
     * Initializes settings from cookies or defaults
     */
    function initSettings() {
        const savedSettings = Utils.getSettingsFromCookie();
        if (savedSettings) {
            settings = {
                streaming: false,
                enableCoT: true,
                showThinking: true,
                selectedModel: 'gemini-2.0-flash', // Default model changed to Gemini 2.0 Flash
                darkMode: true,
                debug: true,
                ...savedSettings
            };
        } else {
            settings = {
                streaming: false,
                enableCoT: true,
                showThinking: true,
                selectedModel: 'gemini-2.0-flash', // Default model changed to Gemini 2.0 Flash
                darkMode: true,
                debug: true
            };
        }
        
        // Apply settings to chat controller
        ChatController.updateSettings(settings);
        
        // Set up settings button
        document.getElementById('settings-button').addEventListener('click', showSettingsModal);

        // Apply light/dark mode
        if (settings.darkMode) {
            document.body.classList.remove('light-mode');
        } else {
            document.body.classList.add('light-mode');
        }

        // Set the dark mode toggle state if present
        setTimeout(() => {
            const darkModeToggle = document.getElementById('dark-mode-toggle');
            if (darkModeToggle) {
                darkModeToggle.checked = !!settings.darkMode;
            }
            const debugToggle = document.getElementById('debug-toggle');
            if (debugToggle) {
                debugToggle.checked = !!settings.debug;
            }
        }, 0);
    }

    /**
     * Get current settings
     * @returns {Object} - The current settings
     */
    function getSettings() {
        return { ...settings };
    }

    // Public API
    return {
        init: initSettings,
        showSettingsModal,
        hideSettingsModal,
        getSettings
    };
})(); 
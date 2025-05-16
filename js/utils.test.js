// Basic test suite for utils.js
(function() {
    function assertEqual(actual, expected, message) {
        if (actual === expected) {
            console.log('PASS:', message);
        } else {
            console.error('FAIL:', message, 'Expected:', expected, 'Got:', actual);
        }
    }

    // Test escapeHtml
    var html = '<div>"Hello" & \'World\'</div>';
    var escaped = Utils.escapeHtml(html);
    assertEqual(escaped, '&lt;div&gt;&quot;Hello&quot; &amp; \'World\'&lt;/div&gt;', 'escapeHtml should escape HTML special chars');

    // Test encrypt/decrypt
    var text = 'Secret123!';
    var key = 'key';
    var encrypted = Utils.encrypt(text, key);
    var decrypted = Utils.decrypt(encrypted, key);
    assertEqual(decrypted, text, 'encrypt/decrypt should be reversible');

    // Test parseSSELine
    var sseLine = 'data: {"foo": "bar"}';
    var parsed = Utils.parseSSELine(sseLine);
    assertEqual(parsed.data.foo, 'bar', 'parseSSELine should parse JSON data');

    // Test parseSSELine with [DONE]
    var doneLine = 'data: [DONE]';
    var doneParsed = Utils.parseSSELine(doneLine);
    assertEqual(doneParsed.done, true, 'parseSSELine should detect [DONE]');

    console.log('Utils tests complete.');
})(); 
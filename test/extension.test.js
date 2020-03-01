const vscode = require('vscode')

suite('Extension Test', function () {
  vscode.window.showInformationMessage('Start all tests')
  test('Something 1', function (done) {
    this.timeout(60000)
  })
})

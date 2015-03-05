App.SearchController = Ember.Controller.extend
  queryParams: ['q']
  q: ''


  window: App.Window


  newTags: ''
  tags: []
  init: ->
    @store.find('tag').then (tags) =>
      @set 'tags', tags.sortBy('count').toArray().reverse()
    @_super()

  margin: 2
  overdraw: 3

  imageSizeText: "200"
  imageSize: Ember.computed 'imageSizeText', ->
    Math.round @get('imageSizeText')

  columnWidth: Ember.computed 'imageSize', ->
    @get('imageSize') + @margin * 2

  rowHeight: Ember.computed 'imageSize', ->
    @get('imageSize') + @margin * 2

  imagesPerRow: Ember.computed 'window.width', 'columnWidth', ->
    Math.floor @get('window.width') / @get('columnWidth')

  rowCount: Ember.computed 'content.length', 'imagesPerRow', ->
    Math.ceil @get('content.length') / @get('imagesPerRow')

  resultsStyle: Ember.computed 'rowHeight', 'rowCount', ->
    "height: #{@get('rowHeight') * @get('rowCount')}px"

  scrollPos: Ember.computed 'window.scrollTop', ->
    # FIXME 72px is hard-coded but should be the height of the toolbar
    @get('window.scrollTop') - 72

  viewPortStartRow: Ember.computed 'scrollPos', 'rowHeight', ->
    val = Math.floor @get('scrollPos') / @get('rowHeight') - @overdraw
    val = 0 if val < 0
    val

  viewPortStyle: Ember.computed 'viewPortStartRow', 'rowHeight', ->
    "top: #{@get('viewPortStartRow') * @get('rowHeight')}px"

  viewPortRowCount: Ember.computed 'window.height', 'rowHeight', ->
    Math.ceil @get('window.height') / @get('rowHeight') + @overdraw * 2

  # Return items that are within visible viewport
  viewPortItems: Ember.computed 'model.loadCount', 'imagesPerRow', 'viewPortStartRow', 'viewPortRowCount', ->
    startIndex = @get('viewPortStartRow') * @get('imagesPerRow')
    endIndex = startIndex + @get('viewPortRowCount') * @get('imagesPerRow')

    console.log "#{@get('viewPortStartRow')} * #{@get('imagesPerRow')} = #{startIndex}"
    console.log "#{startIndex} + #{@get('viewPortRowCount')} * #{@get('imagesPerRow')} = #{endIndex}"

    items = []
    len = @get('model.length')
    model = @get('model')

    for i in [startIndex...endIndex]
      if i >= 0 && i < len
        item = model.objectAt(i)
        items.pushObject item
    items

    Ember.ArrayProxy.create
      content: items

  selected: []


  toggleSelection: (itemId) ->
    @store.find('item', itemId).then (item) =>
      if item.get('isSelected')
        item.set 'isSelected', false
        @get('selected').removeObject item
      else
        item.set 'isSelected', true
        @get('selected').addObject item

  matchOne: (str) ->
    return null if str == ''

    for tag in @get('tags')
      continue unless tag.get('label').toLowerCase().indexOf( str.toLowerCase() ) == 0
      return tag

    return null

  matchMany: (str) ->
    if !str? || str == ''
      return []

    # check for exact match
    tags = @get('tags')

    for tag in tags
      continue unless tag.get('label').toLowerCase() == str.toLowerCase()
      return [tag]

    # attempt to split by comma
    matches = []
    for part in str.split( /,\ */ )
      res = @matchOne part
      matches.push res if res

    return matches if matches.length > 0

    # attempt to split by whitespace
    for part in str.split( /\ +/ )
      res = @matchOne part
      matches.push res if res

    return matches if matches.length > 0

    return []

  tagMatches: Ember.computed 'tags', 'newTags', ->
    Ember.ArrayProxy.create
      content: @matchMany( @get('newTags') )

  selectedTags: Ember.computed 'selected.@each.tags', ->
    index = {}
    tags = []
    @get('selected').forEach (item) ->
      item.get('tags').forEach (tag) ->
        obj = index[tag.id]
        if !obj
          obj = index[tag.id] = Ember.Object.create
            tag: tag
            count: 0
          tags.push obj
        obj.incrementProperty('count')

    tags

  actions:
    imageClick: (itemId) ->
      if @get('selected.length') > 0
        @toggleSelection itemId
      else
        @transitionToRoute 'item', itemId

    imageLongPress: (itemId) ->
      console.log 'controller long press'
      @toggleSelection itemId

    saveNewTags: ->
      itemIds = @get('selected').mapBy 'id'
      tagIds = @matchMany( @get('newTags') ).mapBy 'id'

      if tagIds.length > 0
        App.Item.saveTags itemIds, tagIds
        @set 'newTags', ''

    removeTag: (tag) ->
      itemIds = @get('selected').mapBy 'id'

      App.Item.removeTag itemIds, tag.id
